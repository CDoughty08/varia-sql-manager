import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { cellMarksOf } from '../src/renderer/src/grid/GridView'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { CompareService, compareText } from '../src/renderer/src/results/CompareService'
import { ResultsService, setKey } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'
import { keyAt } from './fixtures/entries'

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function fixture() {
  const client = fakeResultClient(), events = new EventBus(), timers = manualTimers()
  const progress = new Set<(value: ResultsJobProgress) => void>()
  const api = {
    copyResults: vi.fn<VariaApi['copyResults']>(), saveResults: vi.fn<VariaApi['saveResults']>(), cancelResultsJob: vi.fn<VariaApi['cancelResultsJob']>(),
    onResultsJob: vi.fn<VariaApi['onResultsJob']>(listener => { progress.add(listener); return () => { progress.delete(listener) } })
  }
  const results = new ResultsService({ client, api, events, frame: callback => callback(), timers: timers.timers, newId: () => crypto.randomUUID() })
  const compare = new CompareService(results)
  /** Runs a query of `count` complete sets (results 1 to count); `finish: false` leaves it running. */
  let next = 1
  const run = (count: number, o: { finish?: boolean; queryId?: string } = {}) => {
    const queryId = o.queryId ?? 'q1'
    results.begin('t1', queryId)
    const values = Array.from({ length: count }, (_, index) => descriptor(next++, { index }))
    for (const value of values) client.emit(queryId, { type: 'resultSet.opened', descriptor: value })
    if (o.finish !== false) void results.finish('t1', queryId, { summary: summaryOf(values) })
    return results.getSnapshot().t1.sets.map(set => set.handle as FakeHandle)
  }
  return { client, results, compare, run }
}

describe('result diffs', () => {
  it('compares a set with the one before it, appends the diff as the run\'s last set, and says what was compared', async () => {
    const { results, compare, run } = fixture()
    const [first, second] = run(2)
    expect(compare.canCompare('t1', keyAt(results, 't1', 1))).toBe(true)
    expect(compare.canCompare('t1', keyAt(results, 't1', 0))).toBe(false)
    await compare.compare('t1', keyAt(results, 't1', 1))
    await settle()
    expect(first.diff).toHaveBeenCalledWith(second, { exact: false, signal: expect.any(AbortSignal) })
    const sets = results.getSnapshot().t1.sets
    expect(sets).toHaveLength(3)
    expect(sets[2]).toMatchObject({ number: 3, label: 'Differences: Result 1 → Result 2', descriptor: { kind: 'diff', resultId: 901 } })
    expect(results.getSnapshot().t1.settled.get(setKey(sets[2].descriptor))).toEqual({ rows: 3, strip: true })
    const info = compare.getSnapshot().get(setKey(sets[2].descriptor))!
    expect(info).toMatchObject({ left: sets[0].key, right: sets[1].key, leftNumber: 1, rightNumber: 2, key: 'Id', changed: 1, added: 1, removed: 0, same: 1 })
    expect(compareText(info)).toBe('Result 1 → Result 2, rows matched by Id: 1 changed row, 1 added row, 0 removed rows, 1 unchanged.')
    expect(compareText({ ...info, key: null, exact: true, soft: 2, leftOnly: ['Old'], rightOnly: ['New'] }))
      .toBe('Result 1 → Result 2, whole rows matched, text compared exactly: 1 changed row, 1 added row, 0 removed rows, 1 unchanged. 2 values differ only by collation (case or trailing spaces), underlined. Not compared: Old (Result 1), New (Result 2).')
    // A diff is not compared again, nor is a set whose previous one is the diff.
    expect(compare.canCompare('t1', keyAt(results, 't1', 2))).toBe(false)
  })

  it('names a comparison by its results\' numbers, not their places, once an entry before them has gone', async () => {
    const { results, compare, run } = fixture()
    const [, second, third] = run(3)
    const sets = () => results.getSnapshot().t1.sets
    results.removeEntry('t1', sets()[0].key)
    // Result 3 stands second and is compared with Result 2, which stands first.
    const [two, three] = sets()
    expect(compare.previousOf('t1', three.key)).toBe(two)
    expect(compare.canCompare('t1', keyAt(results, 't1', 0))).toBe(false)
    await compare.compare('t1', keyAt(results, 't1', 1))
    await settle()
    expect(second.diff).toHaveBeenCalledWith(third, { exact: false, signal: expect.any(AbortSignal) })
    expect(sets()[2]).toMatchObject({ number: 4, label: 'Differences: Result 2 → Result 3', descriptor: { kind: 'diff', resultId: 902 } })
    const info = compare.getSnapshot().get(setKey(sets()[2].descriptor))!
    expect(info).toMatchObject({ left: two.key, right: three.key, leftNumber: 2, rightNumber: 3 })
    expect(compareText(info)).toBe('Result 2 → Result 3, rows matched by Id: 1 changed row, 1 added row, 0 removed rows, 1 unchanged.')
    expect(compareText({ ...info, leftOnly: ['Old'], rightOnly: ['New'] })).toContain('Not compared: Old (Result 2), New (Result 3).')
  })

  it('compares nothing while the query runs, says why a comparison failed, and keeps only diffs a run still shows', async () => {
    const { results, compare, run } = fixture()
    run(2, { finish: false })
    expect(compare.canCompare('t1', keyAt(results, 't1', 1))).toBe(false)
    const [first] = run(2, { queryId: 'q2' })
    const notify = vi.spyOn(results, 'notify')
    vi.mocked(first.diff).mockRejectedValueOnce(new ResultError('TOO_LARGE', 'There is not enough result memory to compare these results. Close other results and try again.'))
    await compare.compare('t1', keyAt(results, 't1', 1))
    expect(notify).toHaveBeenCalledWith('t1', 'There is not enough result memory to compare these results. Close other results and try again.')
    expect(results.getSnapshot().t1.sets).toHaveLength(2)
    await compare.compare('t1', keyAt(results, 't1', 1))
    expect(compare.getSnapshot().size).toBe(1)
    run(2, { queryId: 'q3' })
    await compare.compare('t1', keyAt(results, 't1', 1))
    expect(compare.getSnapshot().size).toBe(1)
  })

  it('releases a diff a newer run or a closed tab cannot take, and gives up a comparison when a run starts', async () => {
    const { client, results, compare, run } = fixture()
    const [first] = run(2)
    // Scenario A: F5 while the comparison runs. The new run gives it up (its signal aborts) and its late answer is released.
    let answer!: (value: Awaited<ReturnType<FakeHandle['diff']>>) => void
    let signal: AbortSignal | undefined
    vi.mocked(first.diff).mockImplementationOnce((_right, o) => { signal = o?.signal; return new Promise(resolve => { answer = resolve }) })
    const comparing = compare.compare('t1', keyAt(results, 't1', 1))
    run(2, { queryId: 'q2', finish: false })
    expect(signal?.aborted).toBe(true)
    answer({ descriptor: descriptor(950, { index: 2, kind: 'diff' }), key: 'Id', same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [] })
    await comparing
    expect(client.released()).toContain(950)
    expect(results.getSnapshot().t1.sets).toHaveLength(2)
    // Scenario B: the new run finished before the answer: its sets are not the ones compared, so it does not take the diff.
    void results.finish('t1', 'q2', { summary: summaryOf(results.getSnapshot().t1.sets.map(set => set.descriptor)) })
    expect(results.addSet('t1', descriptor(951, { index: 2, kind: 'diff' }), 'Differences: Result 1 → Result 2', [setKey(first.key)])).toBeUndefined()
    expect(client.released()).toContain(951)
    expect(results.getSnapshot().t1.sets).toHaveLength(2)
    // A closed tab takes none either.
    results.release('t1')
    expect(results.addSet('t1', descriptor(952, { index: 2, kind: 'diff' }), 'Differences', [])).toBeUndefined()
    expect(client.released()).toContain(952)
  })

  it('compares only sets that share a column holding the same kind of data', () => {
    const { client, results, compare } = fixture()
    results.begin('t1', 'q1')
    const column = (name: string, wire: 'text' | 'binary') => ({ name, dataType: wire === 'text' ? 'int' : 'varbinary', wire, nullable: false })
    const values = [descriptor(1, { index: 0, columns: [column('Id', 'text')] }), descriptor(2, { index: 1, columns: [column('Id', 'binary')] }), descriptor(3, { index: 2, columns: [column('ID', 'text')] })]
    for (const value of values) client.emit('q1', { type: 'resultSet.opened', descriptor: value })
    void results.finish('t1', 'q1', { summary: summaryOf(values) })
    // Id is binary in the second and text in the first: the backend could pair nothing, so the second is not offered.
    expect(compare.previousOf('t1', keyAt(results, 't1', 1))).toBeUndefined()
    // The third skips the second for the first, whose Id holds text like its own.
    expect(compare.previousOf('t1', keyAt(results, 't1', 2))?.key).toBe(keyAt(results, 't1', 0))
  })

  it('draws highlights and search matches over a diff\'s tones (styles.css order and selectors)', () => {
    const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const at = (rule: string) => { const index = css.indexOf(rule); expect(index, rule).toBeGreaterThanOrEqual(0); return index }
    // Same specificity: the rule that comes later wins, so the highlight rules follow the diff tone rules.
    expect(at('.rg-row.tone-added {')).toBeLessThan(at('.rg-row.hl-yellow {'))
    expect(at('.rg-rn.tone-removed:not(.sel) {')).toBeLessThan(at('.rg-rn.hl-yellow:not(.sel) {'))
    // A changed cell's tint, more specific than a search match's, leaves a match its own.
    expect(css).toContain('.rg-row.tone-added .rg-c.is-chg:not(.is-sel):not(.is-hit) {')
    expect(css).toContain('.rg-row.tone-removed .rg-c.is-chg:not(.is-sel):not(.is-hit) {')
    // Under forced colours a changed cell's outline is the weakest outline rule, so the active cell's and the active
    // match's win.
    expect(css).toContain('.rg-c:where(.is-chg) { outline')
    expect(css).not.toMatch(/\.rg-c\.is-chg[^{]*\{ outline/)
  })

  it('says when values were compared by their stored prefix', () => {
    const info = { left: 'e1', right: 'e2', leftNumber: 1, rightNumber: 2, key: 'Id', exact: false, same: 1, changed: 0, added: 0, removed: 0, soft: 0, leftOnly: [], rightOnly: [], approximate: true }
    expect(compareText(info)).toBe('Result 1 → Result 2, rows matched by Id: 0 changed rows, 0 added rows, 0 removed rows, 1 unchanged. Long values were compared by the part these results keep, so a difference past it does not show.')
  })

  it('reads a diff row\'s differing cells from its tone text', () => {
    expect(cellMarksOf('')).toBeUndefined()
    expect(cellMarksOf('x')).toBeUndefined()
    const marks = cellMarksOf('4 ~6 x')!
    expect([...marks.keys()]).toEqual([4, 6])
    expect(marks.get(4)).not.toBe(marks.get(6))
    // Runs of adjacent columns are ranges; a cut tone's ellipsis, and a range that is backwards or past any result, mark nothing.
    const runs = cellMarksOf('4-6 ~8-9 12 …')!
    expect([...runs.keys()]).toEqual([4, 5, 6, 8, 9, 12])
    expect(runs.get(5)).toBe(runs.get(4))
    expect(runs.get(9)).toBe(marks.get(6))
    expect(cellMarksOf('9-4 3-99999999 -2 ~')).toBeUndefined()
  })
})
