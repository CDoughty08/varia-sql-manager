import { describe, expect, it, vi } from 'vitest'
import { cellKey } from '../src/renderer/src/grid/marks'
import type { ResultHandle, SearchOptions } from '../src/renderer/src/results/ResultClient'
import type { GridSort, ResultSetEntry, TabResults } from '../src/renderer/src/results/ResultsService'
import { ResultsSearchService, searchCount, searchDelayMs, type TabSearch } from '../src/renderer/src/results/search'
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
    return { index, descriptor, handle }
  }
  const results = {
    getSnapshot: () => (tab ? { t1: tab } : {}) as Readonly<Record<string, TabResults>>,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    sortOf: (_tabId: string, index: number) => sorts.get(index)
  }
  const service = new ResultsSearchService({ results, timers, maxMatches: o.maxMatches })
  const show = (sets: ResultSetEntry[], queryId = 'q1', settled = true) => {
    tab = { queryId, status: 'completed', sets, settled: new Map(settled ? sets.map(entry => [`1:${entry.descriptor.resultId}`, { rows: 100, strip: false }]) : []) } as unknown as TabResults
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
    expect(search()).toMatchObject({ status: 'done', total: 3, current: 0, revealIndex: 0 })
    expect(search().marks.get(0)).toMatchObject({ current: { row: 2, column: 1 } })
    expect([...search().marks.get(0)!.cells!]).toEqual([cellKey(2, 1), cellKey(5, 0)])
    expect(search().marks.get(1)?.current).toBeUndefined()
    const reveal = search().reveal
    service.step('t1', 1)
    service.step('t1', 1)
    expect(search()).toMatchObject({ current: 2, revealIndex: 1, reveal: reveal + 2 })
    expect(search().marks.get(1)?.current).toEqual({ row: 0, column: 0 })
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
    expect(search().marks.get(0)!.cells!.size).toBe(2)
    service.step('t1', 1)
    service.step('t1', 1)
    // The third match is past the run: the next run starts after its last row.
    expect(searches.at(-1)).toMatchObject({ fromRow: 4, o: { backward: false } })
    await answerAll()
    expect(search().marks.get(0)!.current).toEqual({ row: 4, column: 0 })
    service.step('t1', -1)
    expect(searches.at(-1)).toMatchObject({ fromRow: 4, o: { backward: true } })
    await answerAll()
    expect(search().marks.get(0)!.current).toEqual({ row: 3, column: 0 })
    service.step('t1', -1)
    expect(search().marks.get(0)!.current).toEqual({ row: 1, column: 0 })
    // Back from the first wraps to the last: the run before the end.
    service.step('t1', -1)
    expect(searches.at(-1)).toMatchObject({ fromRow: 10, o: { backward: true } })
    await answerAll()
    expect(search()).toMatchObject({ current: 4 })
    expect(search().marks.get(0)!.current).toEqual({ row: 9, column: 0 })
    service.step('t1', 1)
    expect(searches.at(-1)).toMatchObject({ fromRow: 0, o: { backward: false } })
    await answerAll()
    expect(search().marks.get(0)!.current).toEqual({ row: 1, column: 0 })
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
    expect(search().marks.get(0)!.current).toEqual({ row: 6, column: 0 })
  })

  it('matches column names here, ignoring case and accents, and steps through the matching columns', () => {
    const { service, set, show, search, searches } = fixture()
    show([set(0, ['OrderId', 'Créé', 'Name'], []), set(1, ['customer_id', 'Total'], [])])
    service.setMode('t1', 'columns')
    service.setText('t1', 'ID', true)
    expect(searches).toHaveLength(0)
    expect(search()).toMatchObject({ mode: 'columns', total: 2, columns: 5, current: 0, revealIndex: 0 })
    expect([...search().marks.get(0)!.columns!]).toEqual([1, 0, 0])
    expect(search().marks.get(0)!.currentColumn).toBe(0)
    service.step('t1', 1)
    expect(search().marks.get(1)).toMatchObject({ currentColumn: 0 })
    expect(search().revealIndex).toBe(1)
    service.setText('t1', 'cree', true)
    expect([...search().marks.get(0)!.columns!]).toEqual([0, 1, 0])
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
    sorts.set(0, { keys: [], view, sorting: false, approximate: false, stale: false })
    show(sets)
    expect(searches).toHaveLength(1)
    expect(search().marks.get(0)?.cells?.size).toBe(3)
    await answerAll()
    expect(search()).toMatchObject({ current: 1, reveal })
    // A newer text aborts what runs.
    service.setText('t1', 'y', true)
    const first = searches[0]
    service.setText('t1', 'z', true)
    expect(first.o.signal?.aborted).toBe(true)
    expect(searches.at(-1)!.text).toBe('z')
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
    expect(service.pendingReveal('t1', 0)).toBe(false)
    expect(service.pendingReveal('t1', 1)).toBe(true)
    service.revealed('t1')
    expect(service.pendingReveal('t1', 1)).toBe(false)
    const focus = search().focus
    service.focus('t1')
    expect(search().focus).toBe(focus + 1)
  })
})
