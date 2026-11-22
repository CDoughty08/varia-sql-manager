// Moving between a comparison's differences (Go to Next or Previous Difference, Go to Possible Match): the units of a row
// from its tone, stepping within a row and across rows through results.diffSeek, where a landing ends up, what the live
// region says, the overview strip's marks, and the Go to Possible Match state (comparisonRowHasPartner).
import { describe, expect, it, vi } from 'vitest'
import type { ResultsDiffSeekResult } from '../src/shared/contracts'
import { landingFor, noneShownText, partnerHiddenText, partnerKind, positionText, rowUnits, stepWithin, unitsText } from '../src/renderer/src/grid/diff-navigation'
import { overviewMarks } from '../src/renderer/src/grid/overview'
import { EventBus } from '../src/renderer/src/core/events'
import { CompareService } from '../src/renderer/src/results/CompareService'
import { DerivedJobs } from '../src/renderer/src/results/derived-jobs'
import type { ResultHandle } from '../src/renderer/src/results/ResultClient'
import { ResultsService, type DiffGridControls, type GridSort } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'

describe('a row\'s change units', () => {
  it('are its listed changed cells in order, then a cut row\'s whole row; an added or removed row is one unit', () => {
    expect(rowUnits('changed 4 0-2 ~3', 6)).toEqual({ row: false, units: [0, 1, 2, 4].map(column => ({ column, whole: false })) })
    expect(rowUnits('changedNew dup 1 3 …', 6).units).toEqual([{ column: 1, whole: false }, { column: 3, whole: false }, { column: 0, whole: true }])
    expect(rowUnits('added poss=12', 6)).toEqual({ row: true, units: [{ column: 0, whole: true }] })
    expect(rowUnits('removed gap=3', 6).row).toBe(true)
    // An old half, an unchanged row (soft cells too) and a missing tone have none; a cell past the columns is ignored.
    for (const tone of ['changedOld 0 2', 'same ~1', null, undefined, '']) expect(rowUnits(tone, 6).units).toEqual([])
    expect(rowUnits('changed 2 9', 3).units).toEqual([{ column: 2, whole: false }])
  })

  it('step within the row from the active cell, or leave it', () => {
    const units = rowUnits('changed 1 3 …', 6), plain = rowUnits('changed 1 3', 6), row = rowUnits('added', 6)
    expect(stepWithin(units, { column: 0, whole: false }, 'next')).toBe(0)
    expect(stepWithin(units, { column: 1, whole: false }, 'next')).toBe(1)
    expect(stepWithin(units, { column: 3, whole: false }, 'next')).toBe(2)
    expect(stepWithin(units, { column: 0, whole: true }, 'next')).toBeUndefined()
    expect(stepWithin(plain, { column: 3, whole: false }, 'next')).toBeUndefined()
    expect(stepWithin(units, { column: 0, whole: true }, 'previous')).toBe(1)
    expect(stepWithin(units, { column: 3, whole: false }, 'previous')).toBe(0)
    expect(stepWithin(units, { column: 1, whole: false }, 'previous')).toBeUndefined()
    // On an added or removed row the active cell is on the row's own unit wherever it is.
    for (const direction of ['next', 'previous'] as const) expect(stepWithin(row, { column: 2, whole: false }, direction)).toBeUndefined()
  })

  it('land on the answer\'s cell, or on the whole row for an added or removed row and a cut row reached going back', () => {
    expect(landingFor('changed 2 4', 2, 'next', 6)).toEqual({ column: 2, whole: false })
    expect(landingFor('removed', 0, 'next', 6)).toEqual({ column: 0, whole: true })
    expect(landingFor('changedNew 1 …', 0, 'previous', 6)).toEqual({ column: 0, whole: true })
    expect(landingFor('changedNew 1 …', 1, 'next', 6)).toEqual({ column: 1, whole: false })
    // A cut row whose listed cells are all soft has only its cut: the whole row, either way.
    expect(landingFor('changed ~0-3 …', 0, 'next', 6)).toEqual({ column: 0, whole: true })
  })

  it('are counted as "Change 2 of 31", "… shown" under a filter', () => {
    expect(positionText(2, 31, false)).toBe('Change 2 of 31')
    expect(positionText(1204, 31876, true)).toBe('Change 1,204 of 31,876 shown')
    expect([unitsText(0), unitsText(1), unitsText(1500)]).toEqual(['No differences', '1 change', '1,500 changes'])
  })

  it('name a row\'s possible match by its kind', () => {
    expect(partnerKind('removed poss=12')).toBe('added')
    expect(partnerKind('added dup poss=3 gap=2')).toBe('removed')
    for (const tone of ['removed', 'changedNew poss=2 1', 'added poss=0', null]) expect(partnerKind(tone)).toBeUndefined()
  })
})

describe('the overview strip', () => {
  it('draws a mark per run of buckets holding a kind, in its own lane', () => {
    // 1 changed, 2 added, 4 removed.
    expect(overviewMarks([0, 1, 3, 2, 0, 4, 4, 5])).toEqual([
      { kind: 'removed', first: 5, last: 7 }, { kind: 'changed', first: 1, last: 2 }, { kind: 'changed', first: 7, last: 7 }, { kind: 'added', first: 2, last: 3 }
    ])
    expect(overviewMarks([0, 0])).toEqual([])
  })
})

/** A run with a comparison, its grid mounted as a stand-in whose active cell, tone and landings the test drives. */
async function fixture() {
  const client = fakeResultClient(), timers = manualTimers()
  const api = { copyResults: vi.fn(), saveResults: vi.fn(), cancelResultsJob: vi.fn(), onResultsJob: vi.fn(() => () => {}) }
  const results = new ResultsService({ client, api: api as never, events: new EventBus(), frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const compare = new CompareService(results, { jobs: new DerivedJobs({ timers: timers.timers }) })
  results.begin('t1', 'q1')
  const values = [0, 1].map(index => descriptor(index + 1, { index }))
  for (const value of values) client.emit('q1', { type: 'resultSet.opened', descriptor: value })
  void results.finish('t1', 'q1', { summary: summaryOf(values) })
  const keys = results.getSnapshot().t1.sets.map(set => set.key)
  await compare.comparePair('t1', keys[0], keys[1], { exact: false })
  const entry = results.getSnapshot().t1.comparisons[0].entry
  const seek = vi.mocked(entry.handle.diffSeek)
  let active: ReturnType<DiffGridControls['active']>
  let shown: ResultHandle = entry.handle
  const land = vi.fn<DiffGridControls['land']>()
  const tones = new Map<number, string>()
  const grid: DiffGridControls = { active: () => active, handle: () => shown, land, tone: row => tones.get(row) }
  results.registerGrid('t1', entry.key, { selectAll: () => {}, repaint: () => {}, fitColumn: () => {}, diff: grid })
  const said = () => compare.getSnapshot().announcements.get(entry.key)?.text
  return { results, compare, entry, seek, land, said, tones, setActive: (value: typeof active) => { active = value }, show: (handle: ResultHandle) => { shown = handle } }
}

describe('moving between a comparison\'s differences', () => {
  it('seeks from before the first row without an active cell, and says where it landed', async () => {
    const view = await fixture()
    view.seek.mockResolvedValueOnce({ row: 4, column: 1, index: 1, total: 9, rows: 12 })
    await view.compare.navigate('t1', view.entry.key, 'next', { focus: true })
    expect(view.seek).toHaveBeenLastCalledWith({ from: -1, direction: 'next' }, expect.any(AbortSignal))
    expect(view.land).toHaveBeenCalledWith(4, { column: 1, whole: false }, expect.any(Function), true)
    // Settled by the row's tone: an added row takes the whole row.
    const settle = view.land.mock.calls[0][2]!
    expect(settle('added')).toEqual({ column: 0, whole: true })
    expect(view.said()).toBe('Change 1 of 9')
    expect(view.compare.positionOf(view.entry, view.entry.handle)).toBe('Change 1 of 9')
    // Another view of it (a sort) shows the position no more.
    expect(view.compare.positionOf(view.entry, {} as ResultHandle)).toBeUndefined()
  })

  it('steps through the active row\'s own changed cells, numbering them from its first', async () => {
    const view = await fixture()
    view.setActive({ row: 6, column: 0, whole: false, tone: 'changed 0 1' })
    view.seek.mockResolvedValueOnce({ row: 6, column: 1, index: 5, total: 9, rows: 12 })
    await view.compare.navigate('t1', view.entry.key, 'next')
    // The seek from the row before answers the row's first unit; the next cell is its second.
    expect(view.seek).toHaveBeenLastCalledWith({ from: 5, direction: 'next' }, expect.any(AbortSignal))
    expect(view.land).toHaveBeenLastCalledWith(6, { column: 1, whole: false }, undefined, false)
    expect(view.said()).toBe('Change 6 of 9')
    // From its last listed cell, the move leaves the row through the backend.
    view.setActive({ row: 6, column: 1, whole: false, tone: 'changed 0 1' })
    view.seek.mockResolvedValueOnce({ row: 9, column: 0, index: 8, total: 9, rows: 12 })
    await view.compare.navigate('t1', view.entry.key, 'next')
    expect(view.seek).toHaveBeenLastCalledWith({ from: 6, direction: 'next' }, expect.any(AbortSignal))
    expect(view.said()).toBe('Change 8 of 9')
  })

  it('lands going back on a cut row\'s whole row, its last unit', async () => {
    const view = await fixture()
    view.setActive({ row: 3, column: 0, whole: false, tone: 'changed 2' })
    view.seek.mockResolvedValueOnce({ row: 1, column: 0, index: 4, total: 9, rows: 12 })
    await view.compare.navigate('t1', view.entry.key, 'previous')
    expect(view.seek).toHaveBeenLastCalledWith({ from: 3, direction: 'previous' }, expect.any(AbortSignal))
    expect(view.land.mock.calls[0][2]!('changed 0 5 …')).toEqual({ column: 0, whole: true })
  })

  it('counts in the filtered view the grid shows, and says when it shows no change', async () => {
    const view = await fixture()
    const filtered = { diffSeek: vi.fn(async (): Promise<ResultsDiffSeekResult> => ({ row: 0, column: 2, index: 1, total: 3, rows: 5 })) } as unknown as ResultHandle
    view.show(filtered)
    const kind = { filter: { op: 'kind' as const, kinds: ['added' as const] }, label: 'Added' }
    vi.spyOn(view.results, 'sortOf').mockReturnValue({ keys: [], filters: [kind], applied: [kind], view: filtered } as unknown as GridSort)
    await view.compare.navigate('t1', view.entry.key, 'next')
    expect(view.said()).toBe('Change 1 of 3 shown')
    vi.mocked(filtered.diffSeek).mockResolvedValueOnce({ none: true })
    await view.compare.navigate('t1', view.entry.key, 'next')
    expect(view.said()).toBe(noneShownText)
    expect(view.land).toHaveBeenCalledTimes(1)
  })

  it('runs a quick repeat after the move in flight, from where that one landed', async () => {
    const view = await fixture()
    view.land.mockImplementation((row, first) => view.setActive({ row, column: first.column, whole: first.whole, tone: undefined }))
    let release: (value: ResultsDiffSeekResult) => void = () => {}
    view.seek.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = view.compare.navigate('t1', view.entry.key, 'next')
    view.seek.mockResolvedValueOnce({ row: 7, column: 0, index: 3, total: 9, rows: 12 })
    const second = view.compare.navigate('t1', view.entry.key, 'next')
    await vi.waitFor(() => expect(view.seek).toHaveBeenCalledTimes(1))
    release({ row: 2, column: 0, index: 1, total: 9, rows: 12 })
    await Promise.all([first, second])
    expect(view.land.mock.calls.map(call => call[0])).toEqual([2, 7])
    expect(view.seek).toHaveBeenLastCalledWith({ from: 2, direction: 'next' }, expect.any(AbortSignal))
    expect(view.said()).toBe('Change 3 of 9')
  })

  it('says why a move failed, unless the comparison went', async () => {
    const view = await fixture()
    view.seek.mockRejectedValueOnce(new Error('The backend stopped.'))
    await view.compare.navigate('t1', view.entry.key, 'next')
    expect(view.said()).toBe('Could not move to the difference: The backend stopped.')
    expect(view.land).not.toHaveBeenCalled()
  })

  it('selects a possible match\'s row, and says when a filter hides it', async () => {
    const view = await fixture()
    view.setActive({ row: 2, column: 1, whole: false, tone: 'removed poss=3' })
    view.seek.mockResolvedValueOnce({ row: 8, column: 0, index: 4, total: 9, rows: 12 })
    await view.compare.goToPossibleMatch('t1', view.entry.key, { focus: true })
    expect(view.seek).toHaveBeenLastCalledWith({ partnerOf: 2 }, expect.any(AbortSignal))
    expect(view.land).toHaveBeenLastCalledWith(8, { column: 0, whole: true }, undefined, true)
    // The toolbar says where it landed, until the active cell leaves that row.
    expect(view.compare.positionOf(view.entry, view.entry.handle)).toBe('Change 4 of 9')
    const set = `${view.entry.descriptor.generation}:${view.entry.descriptor.resultId}`
    view.compare.activeRow('t1', view.entry.key, set, 8, 'added poss=1')
    expect(view.compare.positionOf(view.entry, view.entry.handle)).toBe('Change 4 of 9')
    view.compare.activeRow('t1', view.entry.key, set, 9, null)
    expect(view.compare.positionOf(view.entry, view.entry.handle)).toBeUndefined()
    // A menu's row is used over the active one.
    view.seek.mockResolvedValueOnce({ hidden: true })
    await view.compare.goToPossibleMatch('t1', view.entry.key, { row: 5 })
    expect(view.seek).toHaveBeenLastCalledWith({ partnerOf: 5 }, expect.any(AbortSignal))
    expect(view.said()).toBe(partnerHiddenText)
    expect(view.land).toHaveBeenCalledTimes(1)
  })

  it('offers Go to Possible Match on a row with one, unless only chips filter and its kind is not pressed', async () => {
    const view = await fixture()
    view.results.focusEntry('t1', view.entry.key)
    const set = `${view.entry.descriptor.generation}:${view.entry.descriptor.resultId}`
    const { setKey } = await import('../src/renderer/src/results/ResultsService')
    expect(setKey(view.entry.descriptor)).toBe(set)
    view.compare.activeRow('t1', view.entry.key, set, 2, 'removed poss=3')
    expect(view.compare.toggles.getSnapshot().t1?.partner).toBe(true)
    // A row from another result (an older comparison of the entry) says nothing.
    view.compare.activeRow('t1', view.entry.key, 'old', 2, 'removed poss=3')
    expect(view.compare.toggles.getSnapshot().t1?.partner).toBe(false)
    view.compare.activeRow('t1', view.entry.key, set, 2, 'removed poss=3')
    const chip = (kinds: ('added' | 'removed' | 'changed')[], others: GridSort['filters'] = []) => {
      const kind = { filter: { op: 'kind' as const, kinds }, label: 'Kinds' }
      vi.spyOn(view.results, 'sortOf').mockReturnValue({ keys: [], filters: [kind, ...others], applied: [kind, ...others] } as unknown as GridSort)
    }
    chip(['removed'])
    expect(view.compare.partnerUnavailable('t1', view.entry.key)).toBe(partnerHiddenText)
    // A menu's row is judged by its own tone, read from the grid.
    view.tones.set(5, 'added poss=2')
    expect(view.compare.partnerUnavailable('t1', view.entry.key, 5)).toBeUndefined()
    view.tones.set(5, 'removed poss=2')
    expect(view.compare.partnerUnavailable('t1', view.entry.key, 5)).toBe(partnerHiddenText)
    chip(['removed', 'added'])
    expect(view.compare.partnerUnavailable('t1', view.entry.key)).toBeUndefined()
    // With another filter only the backend can tell.
    chip(['removed'], [{ filter: { op: 'null', column: 0 }, label: 'Id is NULL' } as unknown as GridSort['filters'][number]])
    expect(view.compare.partnerUnavailable('t1', view.entry.key)).toBeUndefined()
    view.compare.activeRow('t1', view.entry.key, set, 3, 'changedNew 1')
    expect(view.compare.toggles.getSnapshot().t1?.partner).toBe(false)
  })
})
