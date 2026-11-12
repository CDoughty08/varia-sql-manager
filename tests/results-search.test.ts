import { describe, expect, it, vi } from 'vitest'
import { focusInRun } from '../src/renderer/src/grid/GridView'
import { cellKey } from '../src/renderer/src/grid/marks'
import { ResultError, type ResultHandle, type SearchOptions } from '../src/renderer/src/results/ResultClient'
import { entryOf, type EntryKey, type GridSort, type ResultSetEntry, type TabResults } from '../src/renderer/src/results/ResultsService'
import { announceDelayMs, ResultsSearchService, searchAnnouncement, searchBoxKeyAction, searchCount, searchDelayMs, type TabSearch } from '../src/renderer/src/results/search'
import type { ResultColumn, ResultDescriptor, ResultsSearchResult } from '../src/shared/contracts'
import { manualTimers } from './fixtures/workbench'

/** A grid's rows as [row, column] matches, searched like the backend: runs of whole rows forward from a row or the last
 *  ones before it, counting every match. */
function backendOf(matches: readonly (readonly [number, number])[], rows: number, complete = true) {
  return (_text: string, fromRow: number, o: SearchOptions = {}): ResultsSearchResult => {
    const max = o.maxMatches ?? 10_000, total = matches.length
    const rowsOf = (list: readonly (readonly [number, number])[]) => [...new Set(list.map(([row]) => row))]
    let kept: (readonly [number, number])[] = []
    if (!o.backward) {
      for (const row of rowsOf(matches.filter(([row]) => row >= fromRow))) { if (kept.length >= max) break; kept.push(...matches.filter(([at]) => at === row)) }
    } else {
      for (const row of rowsOf(matches.filter(([row]) => row < fromRow)).reverse()) { if (kept.length >= max) break; kept = [...matches.filter(([at]) => at === row), ...kept] }
    }
    const first = kept.length ? matches.indexOf(kept[0]) : o.backward ? 0 : matches.filter(([row]) => row < fromRow).length
    return { rows, total, first, matchRows: kept.map(([row]) => row), matchColumns: kept.map(([, column]) => column), complete, approximate: false }
  }
}

const column = (name: string): ResultColumn => ({ name, dataType: 'int', wire: 'text', nullable: true })

function fixture(o: { maxMatches?: number } = {}) {
  const { timers, advance } = manualTimers()
  const listeners = new Set<() => void>()
  const sorts = new Map<number, GridSort>()
  let tab: TabResults | undefined
  const searches: { index: number; text: string; fromRow: number; o: SearchOptions; resolve(): void; reject(error: Error): void; handle: ResultHandle }[] = []
  /** A set whose handle answers searches from `matches` when the test resolves them. */
  const set = (index: number, columns: string[], matches: readonly (readonly [number, number])[], rows = 100, complete = true): ResultSetEntry => {
    const answer = backendOf(matches, rows, complete)
    const handle = {
      key: { generation: 1, resultId: index + 1 },
      search: vi.fn((text: string, fromRow: number, options: SearchOptions = {}) => new Promise<ResultsSearchResult>((resolve, reject) => {
        const entry = { index, text, fromRow, o: options, handle: handle as unknown as ResultHandle, resolve: () => resolve(answer(text, fromRow, options)), reject }
        searches.push(entry)
        options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
    } as unknown as ResultHandle
    const descriptor = { generation: 1, resultId: index + 1, index, columns: columns.map(column) } as unknown as ResultDescriptor
    // The entry's key and number are its result's, as ResultsService keeps them while the entry lives.
    return { key: `e${index + 1}`, ordinal: index + 1, number: index + 1, descriptor, handle }
  }
  const results = {
    getSnapshot: () => (tab ? { t1: tab } : {}) as Readonly<Record<string, TabResults>>,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    // `sorts` is by the place each set was made for (its result id less one), wherever the set stands now.
    sortOf: (_tabId: string, key: EntryKey) => { const entry = entryOf(tab?.sets, key); return entry && sorts.get(entry.descriptor.resultId - 1) }
  }
  const service = new ResultsSearchService({ results, timers, maxMatches: o.maxMatches })
  const show = (sets: ResultSetEntry[], queryId = 'q1', settled = true, status: TabResults['status'] = 'completed') => {
    tab = { queryId, status, sets, settled: new Map(settled ? sets.map(entry => [`1:${entry.descriptor.resultId}`, { rows: 100, strip: false }]) : []) } as unknown as TabResults
    for (const listener of [...listeners]) listener()
  }
  const hide = () => { tab = undefined; for (const listener of [...listeners]) listener() }
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  /** Answers the searches asked so far, one at a time, as the backend would. */
  const answerAll = async () => { for (let i = 0; i < 50; i++) { const next = searches.shift(); if (!next) { await settle(); if (!searches.length) return; continue } next.resolve(); await settle() } }
  const search = (): TabSearch => service.of('t1')
  return { service, timers, advance, searches, set, show, hide, settle, answerAll, search, sorts }
}

describe('ResultsSearchService', () => {
  it('searches every grid in turn once typing pauses, makes the first match active, and steps through all of them, wrapping', async () => {
    const { service, advance, searches, set, show, answerAll, search } = fixture()
    show([set(0, ['a', 'b'], [[2, 1], [5, 0]]), set(1, ['c'], [[0, 0]])])
    service.setText('t1', 'ab')
    expect(search()).toMatchObject({ text: 'ab', status: 'searching', total: 0 })
    expect(searches).toHaveLength(0)
    advance(searchDelayMs)
    // One grid at a time: the second search waits for the first.
    expect(searches.map(entry => entry.index)).toEqual([0])
    await answerAll()
    expect(search()).toMatchObject({ status: 'done', total: 3, current: 0, revealEntry: 'e1' })
    expect(search().marks.get('e1')).toMatchObject({ current: { row: 2, column: 1 } })
    expect([...search().marks.get('e1')!.cells!]).toEqual([cellKey(2, 1), cellKey(5, 0)])
    expect(search().marks.get('e2')?.current).toBeUndefined()
    const reveal = search().reveal
    service.step('t1', 1)
    service.step('t1', 1)
    expect(search()).toMatchObject({ current: 2, revealEntry: 'e2', reveal: reveal + 2 })
    expect(search().marks.get('e2')?.current).toEqual({ row: 0, column: 0 })
    service.step('t1', 1)
    expect(search().current).toBe(0)
    service.step('t1', -1)
    expect(search().current).toBe(2)
    expect(searchCount(search(), String)).toBe('3 of 3')
  })

  it('reads the next run when a step leaves the one held, forward, back, and around the ends', async () => {
    const { service, searches, set, show, answerAll, search } = fixture({ maxMatches: 2 })
    const matches: [number, number][] = [[1, 0], [3, 0], [4, 0], [8, 0], [9, 0]]
    show([set(0, ['a'], matches, 10)])
    service.setText('t1', 'x', true)
    await answerAll()
    expect(search()).toMatchObject({ total: 5, current: 0 })
    expect(search().marks.get('e1')!.cells!.size).toBe(2)
    service.step('t1', 1)
    service.step('t1', 1)
    // The third match is past the run: the next run starts after its last row.
    expect(searches.at(-1)).toMatchObject({ fromRow: 4, o: { backward: false } })
    await answerAll()
    expect(search().marks.get('e1')!.current).toEqual({ row: 4, column: 0 })
    service.step('t1', -1)
    expect(searches.at(-1)).toMatchObject({ fromRow: 4, o: { backward: true } })
    await answerAll()
    expect(search().marks.get('e1')!.current).toEqual({ row: 3, column: 0 })
    service.step('t1', -1)
    expect(search().marks.get('e1')!.current).toEqual({ row: 1, column: 0 })
    // Back from the first wraps to the last: the run before the end.
    service.step('t1', -1)
    expect(searches.at(-1)).toMatchObject({ fromRow: 10, o: { backward: true } })
    await answerAll()
    expect(search()).toMatchObject({ current: 4 })
    expect(search().marks.get('e1')!.current).toEqual({ row: 9, column: 0 })
    service.step('t1', 1)
    expect(searches.at(-1)).toMatchObject({ fromRow: 0, o: { backward: false } })
    await answerAll()
    expect(search().marks.get('e1')!.current).toEqual({ row: 1, column: 0 })
  })

  it('reads a run for a step while the other grids are still searched, without stopping their search', async () => {
    const { service, searches, set, show, settle, search } = fixture({ maxMatches: 1 })
    show([set(0, ['a'], [[1, 0], [6, 0]]), set(1, ['b'], [[2, 0]])])
    service.setText('t1', 'x', true)
    searches.shift()!.resolve()
    await settle()
    expect(search()).toMatchObject({ status: 'searching', total: 2, current: 0 })
    const second = searches[0]
    service.step('t1', 1)
    // The grid's last match: the run before its end.
    expect(searches.at(-1)).toMatchObject({ index: 0, fromRow: 100, o: { backward: true } })
    expect(second.o.signal?.aborted).toBe(false)
    searches.pop()!.resolve()
    second.resolve()
    searches.splice(0)
    await settle()
    expect(search()).toMatchObject({ status: 'done', total: 3, current: 1 })
    expect(search().marks.get('e1')!.current).toEqual({ row: 6, column: 0 })
  })

  it('matches column names here, ignoring case and accents, and steps through the matching columns', () => {
    const { service, set, show, search, searches } = fixture()
    show([set(0, ['OrderId', 'Créé', 'Name'], []), set(1, ['customer_id', 'Total'], [])])
    service.setMode('t1', 'columns')
    service.setText('t1', 'ID', true)
    expect(searches).toHaveLength(0)
    expect(search()).toMatchObject({ mode: 'columns', total: 2, columns: 5, current: 0, revealEntry: 'e1' })
    expect([...search().marks.get('e1')!.columns!]).toEqual([1, 0, 0])
    expect(search().marks.get('e1')!.currentColumn).toBe(0)
    service.step('t1', 1)
    expect(search().marks.get('e2')).toMatchObject({ currentColumn: 0 })
    expect(search().revealEntry).toBe('e2')
    service.setText('t1', 'cree', true)
    expect([...search().marks.get('e1')!.columns!]).toEqual([0, 1, 0])
    expect(searchCount(search(), String)).toBe('1 of 5 columns')
  })

  it('searches again when a grid shows other rows, keeping its place; a newer text stops the running search', async () => {
    const { service, searches, set, show, answerAll, search, sorts } = fixture()
    const sets = [set(0, ['a'], [[1, 0], [2, 0], [3, 0]])]
    show(sets)
    service.setText('t1', 'x', true)
    await answerAll()
    service.step('t1', 1)
    const reveal = search().reveal
    // The grid swaps to a sorted view: the search runs again through it, the old matches showing until it answers.
    const view = { key: { generation: 1, resultId: 1, view: 9 }, viewId: 9, search: sets[0].handle.search } as unknown as NonNullable<GridSort['view']>
    sorts.set(0, { keys: [], filters: [], applied: [], view, sorting: false, approximate: false, stale: false })
    show(sets)
    expect(searches).toHaveLength(1)
    expect(search().marks.get('e1')?.cells?.size).toBe(3)
    await answerAll()
    expect(search()).toMatchObject({ current: 1, reveal })
    // A step while it searches again moves the active match; the end keeps that place and shows it in the new matches.
    sorts.set(0, { keys: [], filters: [], applied: [], view: { ...view, viewId: 10 } as never, sorting: false, approximate: false, stale: false })
    show(sets)
    service.step('t1', 1)
    const stepped = search().reveal
    await answerAll()
    expect(search().current).toBe(2)
    expect(search().reveal).toBe(stepped + 1)
    // A newer text aborts what runs.
    service.setText('t1', 'y', true)
    const first = searches[0]
    service.setText('t1', 'z', true)
    expect(first.o.signal?.aborted).toBe(true)
    expect(searches.at(-1)!.text).toBe('z')
  })

  it('searches again only the grid that changed, and moves the active match off a closed grid to the next one', async () => {
    const { service, searches, set, show, answerAll, search, sorts } = fixture()
    const one = set(0, ['a'], [[1, 0], [2, 0]]), two = set(1, ['a'], [[5, 0]]), three = set(2, ['a'], [[7, 0], [8, 0]])
    show([one, two, three])
    service.setText('t1', 'x', true)
    await answerAll()
    service.step('t1', 1)
    service.step('t1', 1)
    service.step('t1', 1)
    // The active match is the first of the third grid.
    expect(search()).toMatchObject({ total: 5, current: 3, revealEntry: three.key })
    // The first grid is sorted: its view is searched, the other two are not, and the active match stays the third grid's first.
    const sorted = backendOf([[0, 0]], 100)
    const view = { key: one.handle.key, viewId: 4, search: vi.fn(async (text: string, fromRow: number, o: SearchOptions = {}) => sorted(text, fromRow, o)) } as unknown as GridSort['view']
    sorts.set(0, { keys: [], filters: [], applied: [], view, sorting: false, approximate: false, stale: false })
    show([one, two, three])
    await answerAll()
    expect(searches).toHaveLength(0)
    expect(view!.search).toHaveBeenCalledOnce()
    expect([one, two, three].map(entry => (entry.handle.search as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 1])
    expect(search()).toMatchObject({ status: 'done', total: 4, current: 2, revealEntry: three.key })
    expect(search().marks.get(three.key)).toMatchObject({ current: { row: 7, column: 0 } })
    // The run's status changing with every grid as it was (all their rows in) searches nothing.
    show([one, two, three], 'q1', true, 'completedWithErrors')
    expect(view!.search).toHaveBeenCalledOnce()
    expect(searches).toHaveLength(0)
    expect(search()).toMatchObject({ status: 'done', total: 4, current: 2 })
    // The grid holding the active match is closed: the next grid's first match takes its place, or the last of all when
    // none follows. Nothing is searched for it.
    service.step('t1', -1)
    expect(search()).toMatchObject({ current: 1, revealEntry: two.key })
    show([one, three])
    expect(search()).toMatchObject({ status: 'done', total: 3, current: 1 })
    expect(search().marks.get(three.key)).toMatchObject({ current: { row: 7, column: 0 } })
    service.step('t1', 1)
    expect(search()).toMatchObject({ current: 2 })
    show([one])
    expect(search()).toMatchObject({ status: 'done', total: 1, current: 0 })
    expect(view!.search).toHaveBeenCalledOnce()
    expect(searches).toHaveLength(0)
  })

  it('searches a grid again when the run ends if it was searched while its rows were still arriving', async () => {
    const { service, searches, set, show, answerAll, search } = fixture()
    const one = set(0, ['a'], [[1, 0]]), loading = set(1, ['a'], [[2, 0]], 100, false)
    show([one, loading], 'q1', false, 'running')
    service.setText('t1', 'x', true)
    await answerAll()
    expect(search()).toMatchObject({ status: 'done', total: 2, partial: true })
    // The run ends without the sets settling (it failed): what was found mid-stream is not kept as if it were all.
    show([one, loading], 'q1', false, 'failed')
    expect(searches.map(entry => entry.index)).toEqual([1])
    await answerAll()
    expect(loading.handle.search).toHaveBeenCalledTimes(2)
    expect(one.handle.search).toHaveBeenCalledOnce()
  })

  it('keeps the active match on its own grid when a grid before it is searched for the first time', async () => {
    const { service, searches, set, show, answerAll, search, settle } = fixture()
    const one = set(0, ['a'], [[1, 0], [2, 0], [3, 0]]), two = set(1, ['a'], [[5, 0], [6, 0]])
    show([one, two])
    service.setText('t1', 'x', true)
    // The first grid's search fails; the second answers.
    searches.shift()!.reject(new Error('The results could not be searched.'))
    await settle()
    await answerAll()
    service.step('t1', 1)
    expect(search()).toMatchObject({ total: 2, current: 1 })
    expect(search().marks.get(two.key)).toMatchObject({ current: { row: 6, column: 0 } })
    // Searched again (the run's status changed), the first grid answers with three matches: the active match is still the
    // second grid's second, now the fifth of all.
    show([one, two], 'q1', true, 'completedWithErrors')
    await answerAll()
    expect(search()).toMatchObject({ status: 'done', total: 5, current: 4 })
    expect(search().marks.get(two.key)).toMatchObject({ current: { row: 6, column: 0 } })
    expect(two.handle.search).toHaveBeenCalledOnce()
  })

  it('keeps the active column on its own column when an entry before it is closed', () => {
    const { service, set, show, search } = fixture()
    const one = set(0, ['ab', 'b'], []), two = set(1, ['b', 'xb', 'c'], [])
    show([one, two])
    service.setMode('t1', 'columns')
    service.setText('t1', 'b', true)
    service.step('t1', 1)
    service.step('t1', 1)
    expect(search()).toMatchObject({ total: 4, current: 2 })
    expect(search().marks.get(two.key)).toMatchObject({ currentColumn: 0 })
    show([two])
    expect(search()).toMatchObject({ total: 2, current: 0 })
    expect(search().marks.get(two.key)).toMatchObject({ currentColumn: 0 })
    // Its own entry closed: the first matching column after where it stood, or the last of all.
    show([one, two])
    expect(search()).toMatchObject({ total: 4, current: 2 })
    service.step('t1', -1)
    expect(search()).toMatchObject({ total: 4, current: 1 })
    show([two])
    expect(search()).toMatchObject({ total: 2, current: 0 })
  })

  it('says a failure only when no grid could be searched, counts a loading grid as partial, and forgets a closed tab', async () => {
    const { service, searches, set, show, hide, answerAll, search, settle } = fixture()
    show([set(0, ['a'], [[1, 0]], 100, false), set(1, ['b'], [[0, 0]])], 'q1', false)
    service.setText('t1', 'x', true)
    searches.shift()!.resolve()
    await settle()
    searches.shift()!.reject(new Error('These results were closed.'))
    await settle()
    expect(search()).toMatchObject({ status: 'done', total: 1, partial: true })
    expect(searchCount(search(), String)).toBe('1 of 1+')
    show([set(0, ['a'], [])], 'q2')
    service.setText('t1', 'y', true)
    searches.pop()!.reject(new Error('The results could not be searched.'))
    await settle()
    expect(search()).toMatchObject({ status: 'failed', error: 'The results could not be searched.' })
    expect(searchCount(search(), String)).toBe('Search failed')
    service.clear('t1')
    expect(search()).toMatchObject({ text: '', status: 'idle' })
    expect(searchCount(search(), String)).toBe('')
    hide()
    await answerAll()
    expect(service.getSnapshot()).toEqual({})
  })

  it('reveals the active match once, in the grid that holds it, and asks the search box for the focus', async () => {
    const { service, set, show, answerAll, search } = fixture()
    show([set(0, ['a'], []), set(1, ['b'], [[4, 0]])])
    service.setText('t1', 'x', true)
    await answerAll()
    expect(service.pendingReveal('t1', 'e1')).toBe(false)
    expect(service.pendingReveal('t1', 'e2')).toBe(true)
    service.revealed('t1')
    expect(service.pendingReveal('t1', 'e2')).toBe(false)
    const focus = search().focus
    expect(service.takeFocus('t1')).toBe(false)
    service.focus('t1')
    expect(search().focus).toBe(focus + 1)
    // The box takes it once: a box shown again later (a new run's results) leaves the focus where it is.
    expect(service.takeFocus('t1')).toBe(true)
    expect(service.takeFocus('t1')).toBe(false)
  })

  // #346
  it('says so in the count when the run read for a step fails, and reads again after a step', async () => {
    const { service, searches, set, show, answerAll, search, settle } = fixture({ maxMatches: 1 })
    show([set(0, ['a'], [[1, 0], [5, 0], [9, 0]])])
    service.setText('t1', 'x', true)
    await answerAll()
    expect(searchCount(search(), String)).toBe('1 of 3')
    service.step('t1', 1)
    searches.shift()!.reject(new Error('The results could not be searched.'))
    await settle()
    // Nothing is marked for the active match, so the count does not read "2 of 3".
    expect(search()).toMatchObject({ status: 'failed', error: 'The results could not be searched.', total: 3, current: 1 })
    expect(searchCount(search(), String)).toBe('Search failed')
    service.step('t1', 1)
    expect(search().status).toBe('done')
    await answerAll()
    expect(search()).toMatchObject({ status: 'done', current: 2 })
    expect(search().marks.get('e1')!.current).toEqual({ row: 9, column: 0 })
  })

  it('searches again, keeping its place, when the rows a step reads were released, and says a failure if that read fails again', async () => {
    const { service, searches, set, show, answerAll, search, settle } = fixture({ maxMatches: 1 })
    show([set(0, ['a'], [[1, 0], [5, 0], [9, 0]])])
    service.setText('t1', 'x', true)
    await answerAll()
    service.step('t1', 1)
    searches.shift()!.reject(new ResultError('RESULT_RELEASED', 'These results were closed.'))
    await settle()
    // A search again from the first row, not a failure.
    expect(searches).toHaveLength(1)
    expect(searches[0]).toMatchObject({ fromRow: 0 })
    expect(search().status).toBe('searching')
    searches.shift()!.resolve()
    await settle()
    // Its place is outside the run the search returned: the run read again, released again, fails this time.
    expect(searches).toHaveLength(1)
    searches.shift()!.reject(new ResultError('RESULT_RELEASED', 'These results were closed.'))
    await settle()
    expect(searches).toHaveLength(0)
    expect(search()).toMatchObject({ status: 'failed', current: 1 })
  })

  // #347
  it('announces only the settled count, once it has held for a moment, and steps from a grid select the match', async () => {
    const { service, advance, set, show, answerAll, search, searches, settle } = fixture()
    show([set(0, ['a'], [[2, 0], [5, 0]]), set(1, ['b'], [[1, 0]])])
    service.setText('t1', 'a')
    advance(searchDelayMs / 2)
    service.setText('t1', 'ab')
    advance(searchDelayMs)
    expect(search().announcement).toBe('')
    // One grid in: the count shows it, but the live region waits for the search to end.
    searches.shift()!.resolve()
    await settle()
    expect(searchCount(search(), String)).toBe('1 of 2+')
    advance(announceDelayMs * 2)
    expect(search().announcement).toBe('')
    await answerAll()
    expect(searchCount(search(), String)).toBe('1 of 3')
    advance(announceDelayMs - 1)
    expect(search().announcement).toBe('')
    advance(1)
    expect(search().announcement).toBe('1 of 3 matches')
    // Steps in quick succession say only where they end.
    service.step('t1', 1)
    advance(announceDelayMs / 2)
    service.step('t1', 1)
    advance(announceDelayMs / 2)
    expect(search().announcement).toBe('1 of 3 matches')
    advance(announceDelayMs / 2)
    expect(search().announcement).toBe('3 of 3 matches')
    expect(search().revealSelect).toBe(false)
    service.step('t1', 1, true)
    expect(search().revealSelect).toBe(true)
    service.step('t1', 1)
    expect(search().revealSelect).toBe(false)
    // An emptied box is silent at once.
    service.clear('t1')
    expect(search().announcement).toBe('')
    expect(searchAnnouncement({ text: 'x', mode: 'values', status: 'failed', total: 0, current: -1, columns: 0, partial: false, error: 'Lost.' }, String)).toBe('Search failed: Lost.')
    expect(searchAnnouncement({ text: 'x', mode: 'columns', status: 'done', total: 2, current: 0, columns: 7, partial: false }, String)).toBe('2 of 7 columns')
  })

  it('says a new search\'s count even when it is the same as the last search\'s', async () => {
    const { service, set, show, answerAll, search, advance } = fixture()
    show([set(0, ['a'], [[2, 0], [5, 0]])])
    service.setText('t1', 'x', true)
    await answerAll()
    advance(announceDelayMs)
    expect(search().announcement).toBe('1 of 2 matches')
    // The live region empties as the new search starts, so the same words are said again once it settles.
    service.setText('t1', 'xy', true)
    expect(search().announcement).toBe('')
    await answerAll()
    advance(announceDelayMs)
    expect(search().announcement).toBe('1 of 2 matches')
  })

  it('leaves a run read that fails while a search again runs to that search, and a step from a grid keeps its select through it', async () => {
    const { service, searches, set, show, answerAll, search, settle, sorts } = fixture({ maxMatches: 1 })
    const sets = [set(0, ['a'], [[1, 0], [5, 0], [9, 0]])]
    show(sets)
    service.setText('t1', 'x', true)
    await answerAll()
    // A sort swaps the grid: the search runs again; F3 in the grid steps outside the held run meanwhile.
    const view = { key: { generation: 1, resultId: 1, view: 9 }, viewId: 9, search: sets[0].handle.search } as unknown as NonNullable<GridSort['view']>
    sorts.set(0, { keys: [], filters: [], applied: [], view, sorting: false, approximate: false, stale: false })
    show(sets)
    expect(searches).toHaveLength(1)
    service.step('t1', 1, true)
    expect(searches).toHaveLength(2)
    // The view that read was closed by the swap: no "Search failed", the search again reads the run when it ends.
    searches.pop()!.reject(new ResultError('RESULT_RELEASED', 'These results were closed.'))
    await settle()
    expect(search()).toMatchObject({ status: 'searching' })
    expect(search().error).toBeUndefined()
    const reveal = search().reveal
    await answerAll()
    expect(search()).toMatchObject({ status: 'done', current: 1, revealSelect: true, reveal: reveal + 1 })
    expect(search().marks.get('e1')!.current).toEqual({ row: 5, column: 0 })
  })

  it('selects for a waiting reveal only while the focus is still in one of the run\'s grids', () => {
    const root = { dataset: { tabId: 't1' } } as unknown as HTMLElement
    const inGrid = (tabId: string | undefined) => ({ closest: () => (tabId === undefined ? null : { dataset: { tabId } }) }) as unknown as Element
    expect(focusInRun(root, inGrid('t1'))).toBe(true)
    // The editor, the search box, another tab's grid, or nothing focused.
    expect(focusInRun(root, inGrid(undefined))).toBe(false)
    expect(focusInRun(root, inGrid('t2'))).toBe(false)
    expect(focusInRun(root, null)).toBe(false)
    // A live grid names no tab.
    expect(focusInRun({ dataset: {} } as unknown as HTMLElement, inGrid('t1'))).toBe(false)
  })

  it('steps with Enter and clears or leaves with Escape, but not for the Enter that commits an IME composition (#347, #348)', () => {
    const key = (k: string, o: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, ...o })
    expect(searchBoxKeyAction(key('Enter'), true)).toBe('next')
    expect(searchBoxKeyAction(key('Enter', { shiftKey: true }), true)).toBe('previous')
    expect(searchBoxKeyAction(key('Enter', { isComposing: true }), true)).toBeUndefined()
    expect(searchBoxKeyAction(key('Enter', { keyCode: 229 }), true)).toBeUndefined()
    expect(searchBoxKeyAction(key('Enter', { ctrlKey: true }), true)).toBeUndefined()
    expect(searchBoxKeyAction(key('Escape'), true)).toBe('clear')
    expect(searchBoxKeyAction(key('Escape'), false)).toBe('leave')
    expect(searchBoxKeyAction(key('Escape', { isComposing: true }), false)).toBeUndefined()
    expect(searchBoxKeyAction(key('a'), true)).toBeUndefined()
  })

  // #367
  it('keeps each grid\'s matches and the reveal on its entry when a middle entry goes', async () => {
    const { service, set, show, answerAll, search, searches } = fixture()
    const first = set(0, ['a'], [[1, 0]]), middle = set(1, ['ab'], [[2, 0]]), last = set(2, ['abc', 'b'], [[3, 1], [4, 0]])
    show([first, middle, last])
    service.setText('t1', 'b', true)
    await answerAll()
    service.step('t1', 1)
    service.step('t1', 1)
    expect(search()).toMatchObject({ total: 4, current: 2, revealEntry: last.key })
    expect(search().marks.get(last.key)).toMatchObject({ handle: last.handle, current: { row: 3, column: 1 } })
    expect(service.pendingReveal('t1', last.key)).toBe(true)
    // The middle entry goes and the last moves up a place, as ResultsService publishes it: the same entry.
    show([first, last])
    // Nothing is searched again: the grids that stay show the rows they showed, so their matches stand at once, the gone
    // entry's are nowhere, and the entry now second has its own marks, not those of the one that stood there. The active
    // match is still the same match of the same grid, one place earlier among them all.
    expect(searches).toHaveLength(0)
    expect(search()).toMatchObject({ status: 'done', total: 3, current: 1, revealEntry: last.key })
    expect([...search().marks.keys()]).toEqual([first.key, last.key])
    expect(search().marks.get(first.key)).toMatchObject({ handle: first.handle })
    expect(search().marks.get(last.key)).toMatchObject({ handle: last.handle, current: { row: 3, column: 1 } })
    expect(service.pendingReveal('t1', last.key)).toBe(true)
    expect(service.pendingReveal('t1', first.key)).toBe(false)
    expect(service.pendingReveal('t1', middle.key)).toBe(false)
    await answerAll()
    expect(first.handle.search).toHaveBeenCalledOnce()
    expect(last.handle.search).toHaveBeenCalledOnce()
    expect([...search().marks.get(last.key)!.cells!]).toEqual([cellKey(3, 1), cellKey(4, 0)])
    expect(search().marks.has(middle.key)).toBe(false)
    // Column names are kept by entry too.
    service.setMode('t1', 'columns')
    expect([...search().marks.get(last.key)!.columns!]).toEqual([1, 1])
    expect(search()).toMatchObject({ total: 2, current: 0, revealEntry: last.key })
    show([last])
    expect([...search().marks.get(last.key)!.columns!]).toEqual([1, 1])
    expect(search()).toMatchObject({ total: 2, revealEntry: last.key })
    expect(service.pendingReveal('t1', last.key)).toBe(true)
    // The entry that held the active match going leaves no reveal for whatever stands there next.
    service.setMode('t1', 'values')
    show([first])
    expect(search().revealEntry).toBeUndefined()
    expect(service.pendingReveal('t1', first.key)).toBe(false)
  })
  it('never matches or counts a diff\'s or live table\'s hidden tone column in a column-name search', () => {
    const { service, set, show, search } = fixture()
    const diff = set(0, ['id', 'note', 'tone'], [])
    ;(diff.descriptor.columns as ResultColumn[])[2] = { ...column('tone'), dataType: 'nvarchar', role: 'tone' }
    show([diff])
    service.setMode('t1', 'columns')
    service.setText('t1', 'o', true)
    expect(search()).toMatchObject({ total: 1, columns: 2 })
    expect([...search().marks.get('e1')!.columns!]).toEqual([0, 1, 0])
    service.setText('t1', 'tone', true)
    expect(searchCount(search(), String)).toBe('0 of 2 columns')
  })
})
