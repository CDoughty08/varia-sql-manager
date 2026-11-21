import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ResultsJobProgress, VariaApi } from '../src/shared/contracts'
import { EventBus } from '../src/renderer/src/core/events'
import { cellMarksOf, diffKinds, rowToneOf } from '../src/renderer/src/grid/GridView'
import { liveTones } from '../src/shared/live/catalog'
import { cssRules } from './fixtures/css-rules'
import { ResultError } from '../src/renderer/src/results/ResultClient'
import { CompareService, compareText, matchedBy } from '../src/renderer/src/results/CompareService'
import { ResultsService, setKey } from '../src/renderer/src/results/ResultsService'
import { descriptor, fakeResultClient, summaryOf, type FakeHandle } from './fixtures/results'
import { manualTimers } from './fixtures/workbench'
import { keyAt } from './fixtures/entries'
import { limits } from '../src/shared/ipc/wire/protocol'

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
  const run = (count: number, o: { finish?: boolean; queryId?: string; names?: Record<number, string> } = {}) => {
    const queryId = o.queryId ?? 'q1'
    results.begin('t1', queryId)
    const values = Array.from({ length: count }, (_, index) => descriptor(next++, { index, ...o.names?.[index] ? { name: o.names[index] } : {} }))
    for (const value of values) client.emit(queryId, { type: 'resultSet.opened', descriptor: value })
    if (o.finish !== false) void results.finish('t1', queryId, { summary: summaryOf(values) })
    return results.getSnapshot().t1.sets.map(set => set.handle as FakeHandle)
  }
  return { client, results, compare, run, timers }
}

describe('result diffs', () => {
  it('shows a comparison in the toolbar with the phases the backend reports, and a Cancel that gives it up', async () => {
    const { results, compare, run, timers } = fixture()
    const [first] = run(2)
    let stopped: AbortSignal | undefined
    vi.mocked(first.diff).mockImplementationOnce((_right, o) => { stopped = o?.signal; return new Promise((_resolve, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('Cancelled')))) })
    const done = compare.compare('t1', keyAt(results, 't1', 1))
    await settle()
    const progress = vi.mocked(first.diff).mock.lastCall![1]!.onProgress!
    progress('identify', undefined)
    timers.advance(300)
    expect(results.operations.getSnapshot().t1?.items).toMatchObject([{ kind: 'compare', target: 'Result 1 → Result 2', phase: 'identify', shown: true }])
    expect(results.operations.getSnapshot().t1?.items[0]?.percent).toBeUndefined()
    progress('align', 70)
    expect(results.operations.getSnapshot().t1?.items[0]).toMatchObject({ phase: 'align', percent: 70 })
    results.operations.cancel('t1')
    await done
    expect(stopped?.aborted).toBe(true)
    expect(results.operations.getSnapshot().t1).toMatchObject({ items: [], notice: 'Comparison cancelled.' })
    expect(results.getSnapshot().t1.sets).toHaveLength(2)
  })
  it('names a comparison of two results of one name in the toolbar with their numbers', async () => {
    const { results, compare, run, timers } = fixture()
    const [first] = run(2, { names: { 0: 'Totals', 1: 'Totals' } })
    vi.mocked(first.diff).mockImplementationOnce((_right, o) => new Promise((_resolve, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('Cancelled')))))
    const done = compare.compare('t1', keyAt(results, 't1', 1))
    await settle()
    timers.advance(300)
    expect(results.operations.getSnapshot().t1?.items).toMatchObject([{ kind: 'compare', target: 'Totals (Result 1) → Totals (Result 2)' }])
    results.operations.cancel('t1')
    await done
  })
  it('compares a set with the one before it, appends the diff as the run\'s last set, and says what was compared', async () => {
    const { results, compare, run } = fixture()
    const [first, second] = run(2)
    expect(compare.canCompare('t1', keyAt(results, 't1', 1))).toBe(true)
    expect(compare.canCompare('t1', keyAt(results, 't1', 0))).toBe(false)
    await compare.compare('t1', keyAt(results, 't1', 1))
    await settle()
    expect(first.diff).toHaveBeenCalledWith(second, { exact: false, layout: 'entry', signal: expect.any(AbortSignal), onProgress: expect.any(Function) })
    const sets = results.getSnapshot().t1.sets
    expect(sets).toHaveLength(3)
    expect(sets[2]).toMatchObject({ number: 3, label: 'Differences: Result 1 → Result 2', descriptor: { kind: 'diff', resultId: 901 } })
    expect(results.getSnapshot().t1.settled.get(setKey(sets[2].descriptor))).toEqual({ rows: 3, strip: true })
    const info = compare.getSnapshot().info.get(setKey(sets[2].descriptor))!
    expect(info).toMatchObject({ left: sets[0].key, right: sets[1].key, leftNumber: 1, rightNumber: 2, match: { mode: 'auto', columns: ['Id'] }, changed: 1, added: 1, removed: 0, same: 1 })
    expect(compareText(info)).toBe('Result 1 → Result 2, rows matched by Id: 1 changed row, 1 added row, 0 removed rows, 1 unchanged. Filters and sorts on the inputs were not applied.')
    expect(compareText({ ...info, match: { mode: 'rows', columns: [] }, exact: true, soft: 2, leftOnly: ['Old'], rightOnly: ['New'] }))
      .toBe('Result 1 → Result 2, whole rows matched, text compared exactly: 1 changed row, 1 added row, 0 removed rows, 1 unchanged. 2 values differ only by collation (case or trailing spaces), underlined. Not compared: Old (Result 1), New (Result 2). Filters and sorts on the inputs were not applied.')
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
    expect(second.diff).toHaveBeenCalledWith(third, { exact: false, layout: 'entry', signal: expect.any(AbortSignal), onProgress: expect.any(Function) })
    expect(sets()[2]).toMatchObject({ number: 4, label: 'Differences: Result 2 → Result 3', descriptor: { kind: 'diff', resultId: 902 } })
    const info = compare.getSnapshot().info.get(setKey(sets()[2].descriptor))!
    expect(info).toMatchObject({ left: two.key, right: three.key, leftNumber: 2, rightNumber: 3 })
    expect(compareText(info)).toBe('Result 2 → Result 3, rows matched by Id: 1 changed row, 1 added row, 0 removed rows, 1 unchanged. Filters and sorts on the inputs were not applied.')
    expect(compareText({ ...info, leftOnly: ['Old'], rightOnly: ['New'] })).toContain('Not compared: Old (Result 2), New (Result 3).')
    // A named result is called by its name, frozen when compared; one compared before names reads by its number.
    expect(compareText({ ...info, leftName: 'Open orders', leftOnly: ['Old'], rightOnly: ['New'] })).toBe('Open orders → Result 3, rows matched by Id: 1 changed row, 1 added row, 0 removed rows, 1 unchanged. Not compared: Old (Open orders), New (Result 3). Filters and sorts on the inputs were not applied.')
    expect(compareText({ ...info, leftName: 'Open orders' }, [{ name: 'Open orders' }, { name: 'Result 3', entry: three.key }])).toMatch(/^Open orders \(closed\) → Result 3, /)
    const { leftName: _left, rightName: _right, ...before } = info
    expect(compareText(before)).toMatch(/^Result 2 → Result 3, /)
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
    expect(compare.getSnapshot().info.size).toBe(1)
    run(2, { queryId: 'q3' })
    await compare.compare('t1', keyAt(results, 't1', 1))
    expect(compare.getSnapshot().info.size).toBe(1)
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
    answer({ descriptor: descriptor(950, { index: 2, kind: 'diff' }), match: { mode: 'auto', columns: ['Id'] }, same: 1, changed: 0, added: 0, removed: 0, soft: 0, approximate: false, leftOnly: [], rightOnly: [], repeated: 0, possible: 0, possibleSkipped: false, nothingPaired: false, columnChanges: [], trailingHidden: 0, overview: [], units: 0, layout: 'unified' })
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

  it('layers a cell as diff < highlight < search match < selection, none replacing another (styles.css)', () => {
    const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const rules = cssRules(css), screen = rules.filter(rule => rule.at.length === 0)
    const value = (selector: string, property: string) => {
      const rule = screen.find(item => item.selector === selector)
      expect(rule, selector).toBeDefined()
      return rule!.declarations.find(item => item.property === property)?.value
    }
    const layers = (images: string | undefined) => [...(images ?? '').matchAll(/linear-gradient\(var\((--rg-[a-z]+), transparent\)/g)].map(match => match[1])
    // A background image lists its top layer first: the selection over a match over the row's highlight.
    expect(layers(value('.rg-c:is(.is-sel, .is-hit), .rg-row.hl .rg-c', 'background-image'))).toEqual(['--rg-sel', '--rg-hit', '--rg-hl'])
    // The ellipsis of a truncated value is opaque, so it repeats every layer over the grid, the diff's colour lowest.
    expect(layers(value('.rg-c.is-trunc::after', 'background-image'))).toEqual(['--rg-sel', '--rg-hit', '--rg-hl', '--rg-tint'])
    // Over a layer or a diff colour the ellipsis takes the cell's text colour, which the contrast pairs check on those
    // stacks; the truncation colour is checked only on the grid, the stripe and the unfocused selection.
    expect(value('.rg-c.is-trunc:is(.is-sel, .is-hit, .is-chg)::after, .rg-row:is(.hl, .tone-added, .tone-removed) .rg-c.is-trunc::after', 'color')).toBe('inherit')
    // NULL, links and read errors take the grid's text colour on any diff colour or layer (contrast pairs check theirs
    // only on the grid and the stripe), before the focused selection's rule of the same weight, and not in forced colours.
    const plain = rules.find(rule => rule.selector.startsWith('.rg-c:is(.is-null, .is-link, .is-err)'))
    expect(plain?.at).toEqual(['@media (forced-colors: none)'])
    expect(plain?.selector).toBe('.rg-c:is(.is-null, .is-link, .is-err):is(.is-hit, .is-chg), :where(.rg-row:is(.hl, .tone-added, .tone-removed)) .rg-c:is(.is-null, .is-link, .is-err)')
    expect(plain?.declarations).toEqual([{ property: 'color', value: 'var(--varia-resultsGrid-foreground)' }])
    expect(css.indexOf('.rg-c:is(.is-null, .is-link, .is-err)')).toBeLessThan(css.indexOf('.rg:focus-within .rg-c.is-sel {'))
    const marks = rules.find(rule => rule.selector.startsWith('.rg-c:is(.is-hit, .is-chg) .rg-ws'))
    expect(marks?.at).toEqual(['@media (forced-colors: none)'])
    expect(marks?.selector).toBe('.rg-c:is(.is-hit, .is-chg) .rg-ws, :where(.rg-row:is(.hl, .tone-added, .tone-removed)) .rg-c .rg-ws')
    expect(css.indexOf('.rg-c:is(.is-hit, .is-chg) .rg-ws')).toBeLessThan(css.indexOf('.rg-c.is-sel .rg-ws { color: inherit; }'))
    expect(screen.filter(rule => /is-null/.test(rule.selector) && rule.declarations.some(item => item.property === 'color')).map(rule => rule.selector).sort())
      .toEqual(['.rg-c.is-null', '.rg-c.is-sel.is-null', '.rg-row:is(.tone-changed, .tone-changedOld, .tone-changedNew) .rg-c:not(.is-chg, .is-sel, .is-null, .is-link, .is-err)'])
    // The context colour of a changed entry's unchanged cells leaves NULL, links, read errors and the selection their own.
    expect(value('.rg-row:is(.tone-changed, .tone-changedOld, .tone-changedNew) .rg-c:not(.is-chg, .is-sel, .is-null, .is-link, .is-err)', 'color')).toBe('var(--varia-resultsGrid-diffContextForeground)')
    // A selected cell keeps its text colour: the selection is a tint, so an opaque fill's text colour would not fit it.
    expect(screen.filter(rule => /\.is-sel\b/.test(rule.selector) && rule.declarations.some(item => item.property === 'color')).map(rule => rule.selector).sort())
      .toEqual(['.rg-c.is-sel .rg-old, .rg-c.is-sel .rg-arrow', '.rg-c.is-sel .rg-ws', '.rg-c.is-sel.is-null', '.rg-c.is-trunc:is(.is-sel, .is-hit, .is-chg)::after, .rg-row:is(.hl, .tone-added, .tone-removed) .rg-c.is-trunc::after',
        '.rg-row:is(.tone-changed, .tone-changedOld, .tone-changedNew) .rg-c:not(.is-chg, .is-sel, .is-null, .is-link, .is-err)'])
    expect(value('.rg-c.is-sel .rg-old, .rg-c.is-sel .rg-arrow', 'color')).toBe('inherit')
    // The old half's strikethrough sets only the line, keeping a link's or read error's underline beside it.
    expect(value('.rg-row.tone-changedOld .rg-c.is-chg', 'text-decoration')).toBeUndefined()
    expect(value('.rg-row.tone-changedOld .rg-c.is-chg', 'text-decoration-line')).toBe('line-through')
    expect(value('.rg-row.tone-changedOld .rg-c.is-chg:is(.is-err, .is-link)', 'text-decoration-line')).toBe('underline line-through')
    // The diff's colour is the cell's own background colour, under every image.
    for (const selector of ['.rg-row.tone-added .rg-c', '.rg-row.tone-removed .rg-c', '.rg-row.tone-changedNew .rg-c.is-chg', '.rg-row.tone-changedOld .rg-c.is-chg']) {
      expect(value(selector, 'background-color'), selector).toBe('var(--rg-tint)')
      expect(value(selector, '--rg-tint'), selector).toMatch(/^var\(--varia-resultsGrid-diff/)
    }
    // The layers only name their colour; a highlight is the row's variable, read by each cell.
    expect(value('.rg-c.is-hit', '--rg-hit')).toBe('var(--varia-resultsGrid-hitOverlay)')
    expect(value('.rg:focus-within .rg-c.is-sel', '--rg-sel')).toBe('var(--varia-resultsGrid-selectionOverlay)')
    expect(value('.rg:not(:focus-within) .rg-c.is-sel', '--rg-sel')).toBe('var(--varia-resultsGrid-inactiveSelectionOverlay)')
    expect(value('.rg-row.hl-yellow, .rg-rn.hl-yellow', '--rg-hl')).toBe('var(--varia-resultsGrid-highlightYellowBackground)')
    // No other cell or row rule paints a background image, or the shorthand that would clear the layers.
    const painting = screen.filter(rule => /\.rg-(c|row)\b/.test(rule.selector) && rule.declarations.some(item => item.property === 'background' || item.property === 'background-image'))
    expect(painting.map(rule => rule.selector).sort()).toEqual(['.rg-c.is-trunc::after', '.rg-c:is(.is-sel, .is-hit), .rg-row.hl .rg-c', '.rg-row.odd:where(:not(.hl, .tone-added, .tone-removed))',
      '.rg-row.tone-error', '.rg-row.tone-muted', '.rg-row.tone-running', '.rg-row.tone-warning'].sort())
    // A changed half's row is not coloured: only its changed cells are.
    expect(screen.filter(rule => /\.rg-row\.tone-changed(Old|New)$/.test(rule.selector))).toEqual([])
    // The row header keeps its kind bar when selected: a shadow, which the selection's fill does not replace.
    expect(value(".rg[data-gutter='diff'] .rg-rn:is(.tone-added, .tone-changedNew)", 'box-shadow')).toMatch(/^inset 3px 0 0 /)
    // The active match's row underline (`.rg-rn.cur`) is weaker than the bar's rule, so the bar's active rule draws both.
    for (const kinds of ['.tone-added, .tone-changedNew', '.tone-removed, .tone-changedOld']) {
      expect(value(`.rg[data-gutter='diff'] .rg-rn.cur:is(${kinds})`, 'box-shadow')).toMatch(/^inset 3px 0 0 .*, inset 0 -2px 0 var\(--varia-warningForeground\)$/)
    }
    // Under forced colours a changed cell's outline is the weakest outline rule, so the active cell's and the active
    // match's win; on the selection's fill it takes the selection's text colour, and the halves' bars differ in style.
    const forced = rules.filter(rule => rule.at.includes('@media (forced-colors: active)'))
    expect(forced.find(rule => rule.selector === '.rg-c:where(.is-chg)')?.declarations[0]).toEqual({ property: 'outline', value: '1px solid CanvasText' })
    expect(forced.find(rule => rule.selector === '.rg-c.is-sel:where(.is-chg)')?.declarations).toEqual([{ property: 'outline-color', value: 'HighlightText' }])
    expect(forced.find(rule => rule.selector === '.rg-rn:is(.tone-removed, .tone-changedOld)')?.declarations).toEqual([{ property: 'border-left', value: '3px dashed CanvasText' }])
    expect(css).not.toMatch(/\.rg-c\.is-chg[^{]*\{ outline/)
    // A forced-colours match is Mark even on a diff colour or highlight: four classes, after the four-class changed rule.
    const hit = forced.find(rule => rule.selector === '.rg-row .rg-c.is-hit.is-hit, .rg-row .rg-c.is-hit.is-hit.is-trunc::after')
    expect(hit?.declarations.find(item => item.property === 'background')?.value).toBe('Mark')
    expect(css.indexOf('.rg-row .rg-c.is-hit.is-hit')).toBeGreaterThan(css.indexOf('.rg-row.tone-changedOld .rg-c.is-chg {'))
  })

  it('reads a row\'s tone from its tone text\'s kind, whatever flags and cells follow', () => {
    expect(rowToneOf('removed')).toBe('removed')
    expect(rowToneOf('added poss=4')).toBe('added')
    expect(rowToneOf('removed 2 ~4')).toBe('removed')
    expect(rowToneOf('changedOld dup gap=3 2 ~4')).toBe('changedOld')
    expect(rowToneOf('changedNew 0-3 …')).toBe('changedNew')
    expect(rowToneOf('same ~1')).toBe('same')
    // The comparison kinds never name a live tone, so one set of grid classes serves both.
    expect(diffKinds.filter(kind => (liveTones as readonly string[]).includes(kind))).toEqual([])
    // Flags are not cells.
    expect([...cellMarksOf('dup poss=3 gap=12 4')!.keys()]).toEqual([4])
    expect(rowToneOf('error')).toBe('error')
    expect(rowToneOf('')).toBe('')
  })

  it('says how rows were matched, from the answer\'s match', () => {
    expect(matchedBy({ mode: 'auto', columns: ['Id'] })).toBe('rows matched by Id')
    expect(matchedBy({ mode: 'rows', columns: [] })).toBe('whole rows matched')
    expect(matchedBy({ mode: 'position', columns: [] })).toBe('rows matched by position')
    expect(matchedBy({ mode: 'columns', columns: ['Id', 'Status'] })).toBe('rows matched by Id, Status')
  })

  it('says when values were compared by their stored prefix', () => {
    const info = { left: 'e1', right: 'e2', leftNumber: 1, rightNumber: 2, match: { mode: 'auto' as const, columns: ['Id'] }, layout: 'unified' as const, pairs: 1, columnChanges: [], exact: false, same: 1, changed: 0, added: 0, removed: 0, soft: 0, leftOnly: [], rightOnly: [], approximate: true }
    expect(compareText(info)).toBe('Result 1 → Result 2, rows matched by Id: 0 changed rows, 0 added rows, 0 removed rows, 1 unchanged. Long values were compared by the part these results keep, so a difference past it does not show. Filters and sorts on the inputs were not applied.')
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

describe('change index limits', () => {
  it('match their C# twins in DiffIndex', () => {
    const source = readFileSync('backend/Varia.Backend/Results/DiffIndex.cs', 'utf8')
    const constant = (name: string) => Number(new RegExp(`\\b${name} = (\\d+);`).exec(source)?.[1])
    expect([constant('OverviewBuckets'), constant('BlockRows'), constant('MaxKinds')]).toEqual([limits.diff.overviewBuckets, limits.diff.indexBlockRows, limits.diff.maxKinds])
  })

  it('give the one-row layout the pairs that fit a page with their previous values and the suffix (UnifiedDiff)', () => {
    const source = readFileSync('backend/Varia.Backend/Results/ResultDiff.cs', 'utf8')
    expect(source).toContain('public const int MaxEntryPairs = (PageBuilder.MaxColumns - SuffixColumns) / 2;')
    expect(source).toContain('public const int SuffixColumns = 4;')
    expect(limits.diff.maxEntryPairs).toBe((limits.page.maxColumns - 4) / 2)
  })
})
