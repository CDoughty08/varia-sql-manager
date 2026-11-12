// Search in results (the results toolbar's search box): every grid of a tab's run searched in the backend (results.search)
// through the order it shows, or its column names matched here from the descriptors. Rows never come to the renderer: each
// grid keeps one run of matches (at most limits.search.maxMatches, in whole rows) around the active match, and asks for the
// next run when a step leaves it.
import type { ResultsSearchResult } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable } from '../core/types'
import { toneColumnOf } from '../grid/GridView'
import { cellKey, type GridMarks } from '../grid/marks'
import { ResultError, type ResultHandle } from './ResultClient'
import { setKey, type EntryKey, type ResultsService, type TabResults } from './ResultsService'
import { formatCount } from './status'

export type { GridMarks }

export type SearchMode = 'values' | 'columns'

/**
 * One tab's search. `total` counts the matches (values) or matching columns (columns) over every grid, `current` is the
 * active one's place among them (-1 for none). `partial`: a grid was still loading, so more rows may match; `approximate`:
 * a truncated value was searched by its stored prefix. `reveal` changes when the active match should scroll into view
 * (`revealEntry` is its grid's entry; `revealSelect`: the grid also makes it its active cell, for a step taken from a
 * grid); `focus` when the search box should take the focus. `marks` and `revealEntry` are by entry key, and name only
 * entries the run still has. `announcement` is what the box's live region says: the count once it
 * has settled for announceDelayMs, so typing and grids arriving one by one do not read out every count in between.
 */
export interface TabSearch {
  readonly text: string
  readonly mode: SearchMode
  readonly status: 'idle' | 'searching' | 'done' | 'failed'
  readonly total: number
  readonly current: number
  /** Columns mode: the columns of every grid. */
  readonly columns: number
  readonly partial: boolean
  readonly approximate: boolean
  readonly error?: string
  readonly marks: ReadonlyMap<EntryKey, GridMarks>
  readonly reveal: number
  readonly revealEntry?: EntryKey
  readonly revealSelect: boolean
  readonly focus: number
  readonly announcement: string
}

/** A grid's search: the entry it searched (`key`), what it searched (`handle`, `signature`), how many matched, and the
 *  run of matches held. */
interface GridRun {
  readonly key: EntryKey
  readonly handle: ResultHandle
  readonly signature: string
  total: number
  approximate: boolean
  complete: boolean
  searched: number
  /** The matches before `rows[0]`. */
  first: number
  rows: readonly number[]
  columns: readonly number[]
}
interface TabState {
  text: string
  mode: SearchMode
  status: TabSearch['status']
  error?: string
  current: number
  grids: GridRun[]
  /** Columns mode: each grid's matching columns, by entry key. */
  names: Map<EntryKey, number[]>
  columnCount: number
  /** What the search covers: the run, and each grid's view and completeness; a change searches again. */
  signature: string
  /** The running search of every grid. */
  abort?: AbortController
  /** The running read of the run that holds the active match. */
  fetch?: AbortController
  timer?: unknown
  reveal: number
  /** The entry the active match is in. */
  revealKey?: EntryKey
  revealSelect: boolean
  /** The reveal a grid has carried out. */
  revealed?: number
  /** The signature a released run read searched again at, so a read that fails again says so instead of looping. */
  retried?: string
  announcement: string
  announceTimer?: unknown
  announcePending?: string
  focus: number
  /** A focus asked for that no search box has taken yet. */
  focusPending?: boolean
  published?: TabSearch
}

const idle: TabSearch = { text: '', mode: 'values', status: 'idle', total: 0, current: -1, columns: 0, partial: false, approximate: false, marks: new Map(), reveal: 0, revealSelect: false, focus: 0, announcement: '' }
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
/** Column names match ignoring case and accents, as identifiers do under the usual _CI_AI collations. */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
/** Typing searches once it pauses this long; Enter searches at once. */
export const searchDelayMs = 200
/** The live region speaks a count only once it has stayed the same this long. */
export const announceDelayMs = 500
const searchFailed = 'The results could not be searched.'

export class ResultsSearchService extends SnapshotStore<Readonly<Record<string, TabSearch>>> implements Disposable {
  private readonly results: Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'sortOf'>
  private readonly timers: Timers
  private readonly maxMatches: number
  private readonly tabs = new Map<string, TabState>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(o: { results: Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'sortOf'>; timers?: Timers; maxMatches?: number }) {
    super({})
    this.results = o.results
    this.timers = o.timers ?? browserTimers
    this.maxMatches = o.maxMatches ?? wire.search.maxMatches
    this.unsubscribe = this.results.subscribe(() => this.resultsChanged())
  }

  /** A tab's search, or the idle one. */
  of(tabId: string): TabSearch { return this.getSnapshot()[tabId] ?? idle }

  /** The search box's text: searched once typing pauses (at once with `now`); empty clears the search. */
  setText(tabId: string, text: string, now = false): void {
    const tab = this.state(tabId)
    const next = text.slice(0, wire.search.maxText)
    if (next === tab.text && !now) return
    tab.text = next
    this.restart(tabId, tab, now ? 0 : searchDelayMs)
  }

  setMode(tabId: string, mode: SearchMode): void {
    const tab = this.state(tabId)
    if (tab.mode === mode) return
    tab.mode = mode
    this.restart(tabId, tab, 0)
  }

  /** Next (1) or previous (-1) match, wrapping; a search still waiting for typing to pause runs first. `select`: the step
   *  came from a grid (F3 there), so the match also becomes the active cell, which the grid announces and Copy copies. */
  step(tabId: string, delta: 1 | -1, select = false): void {
    const tab = this.tabs.get(tabId)
    if (!tab || !tab.text) return
    if (tab.timer !== undefined) return this.restart(tabId, tab, 0)
    const total = this.total(tab)
    if (total === 0) return
    tab.current = tab.current < 0 ? (delta > 0 ? 0 : total - 1) : (tab.current + delta + total) % total
    this.reveal(tab, select)
    // A failed run read said so; this step reads again if it needs to, and says so again if that fails.
    if (tab.status === 'failed') { tab.status = 'done'; tab.error = undefined }
    this.publishTab(tabId, tab)
    if (tab.mode === 'values') void this.ensureRun(tabId, tab)
  }

  /** Whether the grid of the entry `key` should scroll the active match into view: the tab's latest reveal is in it and no
   *  grid has shown it yet (a grid mounted later, once the stack scrolled to it, still does). `revealed` records that one did. */
  pendingReveal(tabId: string, key: EntryKey): boolean {
    const tab = this.tabs.get(tabId)
    return !!tab && tab.reveal > 0 && tab.revealKey === key && tab.revealed !== tab.reveal
  }
  revealed(tabId: string): void { const tab = this.tabs.get(tabId); if (tab) tab.revealed = tab.reveal }

  /** Clears the text and the marks. */
  clear(tabId: string): void { if (this.tabs.get(tabId)?.text) this.setText(tabId, '', true) }

  /** Find in Results (Ctrl+F in a grid): the tab's search box takes the focus. */
  focus(tabId: string): void {
    const tab = this.state(tabId)
    tab.focus++
    tab.focusPending = true
    this.publishTab(tabId, tab)
  }
  /** Whether the tab's search box should take the focus now: once per focus asked for, so a box shown again later (a run
   *  that brings new results, a switch back from Messages) leaves the focus where it is. */
  takeFocus(tabId: string): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab?.focusPending) return false
    tab.focusPending = false
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    for (const tab of this.tabs.values()) { this.stop(tab); this.stopAnnouncing(tab) }
    this.tabs.clear()
    this.clearListeners()
  }

  private state(tabId: string): TabState {
    let tab = this.tabs.get(tabId)
    if (!tab) {
      tab = { text: '', mode: 'values', status: 'idle', current: -1, grids: [], names: new Map(), columnCount: 0, signature: '', reveal: 0, revealSelect: false, focus: 0, announcement: '' }
      this.tabs.set(tabId, tab)
    }
    return tab
  }

  private stop(tab: TabState): void {
    tab.abort?.abort()
    tab.abort = undefined
    tab.fetch?.abort()
    tab.fetch = undefined
    if (tab.timer !== undefined) { this.timers.clearTimeout(tab.timer); tab.timer = undefined }
  }
  private stopAnnouncing(tab: TabState): void {
    if (tab.announceTimer !== undefined) { this.timers.clearTimeout(tab.announceTimer); tab.announceTimer = undefined }
  }

  private restart(tabId: string, tab: TabState, delay: number): void {
    this.stop(tab)
    tab.current = -1
    tab.grids = []
    tab.names = new Map()
    tab.error = undefined
    tab.status = tab.text ? 'searching' : 'idle'
    // A new search empties the live region, so a count it settles on is said even when it is the last search's.
    tab.announcement = ''
    if (!tab.text) { this.publishTab(tabId, tab); return }
    this.publishTab(tabId, tab)
    if (delay > 0) tab.timer = this.timers.setTimeout(() => { tab.timer = undefined; this.run(tabId, tab, true) }, delay)
    else this.run(tabId, tab, true)
  }

  /** The grids a search covers now: each set, through the view its grid shows (or is about to). */
  private targets(tabId: string, results: TabResults | undefined): { key: EntryKey; handle: ResultHandle; signature: string }[] {
    if (!results) return []
    return results.sets.map(set => {
      const view = this.results.sortOf(tabId, set.key)?.view
      return { key: set.key, handle: view ?? set.handle, signature: `${setKey(set.descriptor)}#${view?.viewId ?? ''}${results.settled.has(setKey(set.descriptor)) ? '' : '+'}` }
    })
  }

  private signatureOf(tabId: string, results: TabResults | undefined): string {
    return results ? results.queryId + '|' + results.status + '|' + this.targets(tabId, results).map(target => target.signature).join(',') : ''
  }

  /** The results changed: a tab whose grids now show other rows (a new run, a sort, a set that finished) searches again,
   *  keeping its place; a tab whose results went is forgotten. */
  private resultsChanged(): void {
    if (this.disposed) return
    const all = this.results.getSnapshot()
    for (const [tabId, tab] of this.tabs) {
      const results = all[tabId]
      if (!results) { this.stop(tab); this.stopAnnouncing(tab); this.tabs.delete(tabId); this.publishAll(); continue }
      if (!tab.text || tab.timer !== undefined) continue
      if (this.signatureOf(tabId, results) !== tab.signature) {
        this.stop(tab)
        this.run(tabId, tab, false)
      }
    }
  }

  /** Searches every grid in turn (one search at a time, as each reads all its rows). `fresh`: a new text or mode, whose
   *  first match becomes active and scrolls into view; otherwise the active match keeps its place where it can. */
  private run(tabId: string, tab: TabState, fresh: boolean): void {
    const results = this.results.getSnapshot()[tabId]
    tab.signature = this.signatureOf(tabId, results)
    const targets = this.targets(tabId, results)
    if (tab.mode === 'columns') {
      const query = fold(tab.text)
      tab.names = new Map()
      tab.columnCount = 0
      for (const set of results?.sets ?? []) {
        // A live table's or diff's tone column is hidden: never matched, nor counted among the columns.
        const hits: number[] = [], tone = toneColumnOf(set.descriptor)
        set.descriptor.columns.forEach((column, index) => { if (index !== tone && fold(column.name).includes(query)) hits.push(index) })
        tab.names.set(set.key, hits)
        tab.columnCount += set.descriptor.columns.length - (tone >= 0 ? 1 : 0)
      }
      tab.status = 'done'
      const total = this.total(tab)
      tab.current = total === 0 ? -1 : fresh || tab.current < 0 ? 0 : Math.min(tab.current, total - 1)
      if (fresh && total > 0) this.reveal(tab)
      this.publishTab(tabId, tab)
      return
    }
    // A search again keeps showing the last matches until the new ones are all in; a new one shows each grid's as it comes.
    // Steps taken while it runs move the active match among the last matches; it keeps that place, shown again at the end.
    const steps = tab.reveal
    const grids: GridRun[] = []
    if (fresh) { tab.grids = grids; tab.current = -1 }
    tab.status = 'searching'
    const abort = tab.abort = new AbortController()
    this.publishTab(tabId, tab)
    void (async () => {
      let failure: string | undefined
      for (const target of targets) {
        if (abort.signal.aborted) return
        try {
          const found = await target.handle.search(tab.text, 0, { maxMatches: this.maxMatches, signal: abort.signal })
          if (abort.signal.aborted) return
          grids.push(this.gridRun(target, found))
        } catch (error) {
          if (abort.signal.aborted || isAbort(error)) return
          // A released or lost result has nothing to find; any other failure is said once the others are searched.
          failure ??= error instanceof Error ? error.message : searchFailed
          continue
        }
        if (!fresh) continue
        if (tab.current < 0 && this.total(tab) > 0) { tab.current = 0; this.reveal(tab) }
        this.publishTab(tabId, tab)
      }
      if (abort.signal.aborted) return
      tab.abort = undefined
      tab.grids = grids
      const total = this.total(tab)
      if (!fresh) {
        tab.current = total === 0 ? -1 : Math.max(0, Math.min(tab.current, total - 1))
        // Shown again as the step showed it: a step from a grid still moves its active cell.
        if (tab.reveal !== steps && tab.current >= 0) this.reveal(tab, tab.revealSelect)
      }
      tab.status = failure && grids.length === 0 ? 'failed' : 'done'
      tab.error = failure && grids.length === 0 ? failure : undefined
      this.publishTab(tabId, tab)
      // A kept place may be outside the runs the searches returned.
      if (tab.current >= 0) void this.ensureRun(tabId, tab)
    })()
  }

  private gridRun(target: { key: EntryKey; handle: ResultHandle; signature: string }, found: ResultsSearchResult): GridRun {
    return { key: target.key, handle: target.handle, signature: target.signature, total: found.total, approximate: found.approximate, complete: found.complete, searched: found.rows,
      first: found.first, rows: found.matchRows, columns: found.matchColumns }
  }

  private total(tab: TabState): number {
    if (tab.mode === 'columns') { let total = 0; for (const hits of tab.names.values()) total += hits.length; return total }
    let total = 0
    for (const grid of tab.grids) total += grid.total
    return total
  }

  /** The grid holding match `current`, and the match's place among that grid's. */
  private locate(tab: TabState): { grid: GridRun; local: number } | undefined {
    let offset = tab.current
    if (offset < 0) return undefined
    for (const grid of tab.grids) {
      if (offset < grid.total) return { grid, local: offset }
      offset -= grid.total
    }
    return undefined
  }

  private locateColumn(tab: TabState): { key: EntryKey; column: number } | undefined {
    let offset = tab.current
    if (offset < 0) return undefined
    for (const [key, hits] of tab.names) {
      if (offset < hits.length) return { key, column: hits[offset] }
      offset -= hits.length
    }
    return undefined
  }

  /** Reads the run that holds the active match when the grid's run does not: the next one forward or back from the run it
   *  has, or the first or last when a step wrapped around. */
  private async ensureRun(tabId: string, tab: TabState): Promise<void> {
    const at = this.locate(tab)
    if (!at) return
    const { grid, local } = at
    if (local >= grid.first && local < grid.first + grid.rows.length) return
    tab.fetch?.abort()
    const abort = tab.fetch = new AbortController()
    const last = grid.rows.length > 0 ? grid.rows[grid.rows.length - 1] : -1
    const backward = local === grid.total - 1 ? true : local === 0 ? false : local < grid.first
    const fromRow = local === grid.total - 1 ? grid.searched : local === 0 ? 0 : backward ? grid.rows[0] ?? grid.searched : last + 1
    try {
      const found = await grid.handle.search(tab.text, fromRow, { maxMatches: this.maxMatches, backward, signal: abort.signal })
      if (abort.signal.aborted) return
      tab.fetch = undefined
      Object.assign(grid, { first: found.first, rows: found.matchRows, columns: found.matchColumns })
      if (tab.status === 'failed') { tab.status = 'done'; tab.error = undefined }
      this.publishTab(tabId, tab)
    } catch (error) {
      if (abort.signal.aborted || isAbort(error)) return
      tab.fetch = undefined
      // A search again is running (a sort swapped the grid, closing the view this read): it reads the active match's run
      // itself once it ends, so this failure says nothing.
      if (tab.abort) return
      // The rows searched went (a sorted view closed once its grid swapped, a result released): search again over what the
      // grids show now, keeping the place; once per signature, so a read that keeps failing says so instead of looping.
      if (error instanceof ResultError && error.code === 'RESULT_RELEASED' && tab.retried !== tab.signature) {
        tab.retried = tab.signature
        this.run(tabId, tab, false)
        return
      }
      // Nothing is marked for the active match: the count says the search failed rather than "3 of 8".
      tab.status = 'failed'
      tab.error = error instanceof Error ? error.message : searchFailed
      this.publishTab(tabId, tab)
    }
  }

  private reveal(tab: TabState, select = false): void {
    tab.reveal++
    tab.revealSelect = select
    tab.revealKey = tab.mode === 'columns' ? this.locateColumn(tab)?.key : this.locate(tab)?.grid.key
  }

  private publishTab(tabId: string, tab: TabState): void {
    if (this.disposed) return
    const marks = new Map<EntryKey, GridMarks>()
    let partial = false, approximate = false
    // Marks and the reveal go to the grids by entry key; an entry that has gone has none.
    const sets = this.results.getSnapshot()[tabId]?.sets ?? []
    const shown = new Set(sets.map(set => set.key))
    const revealEntry = tab.revealKey !== undefined && shown.has(tab.revealKey) ? tab.revealKey : undefined
    if (tab.mode === 'columns' && tab.text) {
      const active = this.locateColumn(tab)
      for (const set of sets) {
        const columns = new Uint8Array(set.descriptor.columns.length)
        for (const column of tab.names.get(set.key) ?? []) columns[column] = 1
        marks.set(set.key, active?.key === set.key ? { columns, currentColumn: active.column } : { columns })
      }
    } else if (tab.text) {
      const active = this.locate(tab)
      for (const grid of tab.grids) {
        partial ||= !grid.complete
        approximate ||= grid.approximate
        if (grid.rows.length === 0 || !shown.has(grid.key)) continue
        const cells = new Set<number>()
        for (let k = 0; k < grid.rows.length; k++) cells.add(cellKey(grid.rows[k], grid.columns[k]))
        const at = active?.grid === grid ? active.local - grid.first : -1
        const current = at >= 0 && at < grid.rows.length ? { row: grid.rows[at], column: grid.columns[at] } : undefined
        marks.set(grid.key, current ? { handle: grid.handle, cells, current } : { handle: grid.handle, cells })
      }
    }
    tab.published = {
      text: tab.text, mode: tab.mode, status: tab.status, total: this.total(tab), current: tab.current, columns: tab.columnCount, partial, approximate,
      ...tab.error ? { error: tab.error } : {}, marks, reveal: tab.reveal, ...revealEntry === undefined ? {} : { revealEntry }, revealSelect: tab.revealSelect, focus: tab.focus,
      announcement: tab.announcement
    }
    this.announce(tabId, tab, tab.published)
    this.publishAll()
  }

  /** Schedules the live region's next words: the settled count, said once it has not changed for announceDelayMs; nothing
   *  while a search runs, and silence at once when the box is emptied. */
  private announce(tabId: string, tab: TabState, search: TabSearch): void {
    const next = searchAnnouncement(search, formatCount)
    if (tab.announceTimer !== undefined && next === tab.announcePending) return
    this.stopAnnouncing(tab)
    if (next === tab.announcement || search.status === 'searching') return
    if (!next) { tab.announcement = ''; tab.published = { ...search, announcement: '' }; return }
    tab.announcePending = next
    tab.announceTimer = this.timers.setTimeout(() => {
      tab.announceTimer = undefined
      if (this.disposed || this.tabs.get(tabId) !== tab || !tab.published) return
      tab.announcement = next
      tab.published = { ...tab.published, announcement: next }
      this.publishAll()
    }, announceDelayMs)
  }

  private publishAll(): void {
    const next: Record<string, TabSearch> = {}
    for (const [tabId, tab] of this.tabs) if (tab.published) next[tabId] = tab.published
    this.publish(next)
  }
}

/** What a key does in the search box: Enter and Shift+Enter step (never the Enter that commits an IME composition), Escape
 *  clears the text or, with none, leaves for the grid. */
export function searchBoxKeyAction(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'keyCode'>, hasText: boolean): 'next' | 'previous' | 'clear' | 'leave' | undefined {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return undefined
  if (event.key === 'Enter') return event.shiftKey ? 'previous' : 'next'
  if (event.key === 'Escape' && !event.shiftKey) return hasText ? 'clear' : 'leave'
  return undefined
}

/** What the live region says for a search: its count and what it counts ("2 of 8 matches"), the failure, or nothing while it
 *  runs or the box is empty. */
export function searchAnnouncement(search: Pick<TabSearch, 'text' | 'mode' | 'status' | 'total' | 'current' | 'columns' | 'partial' | 'error'>, format: (n: number) => string): string {
  if (!search.text || search.status === 'searching') return ''
  if (search.status === 'failed') return search.error ? `Search failed: ${search.error}` : 'Search failed'
  if (search.mode === 'columns') return `${format(search.total)} of ${format(search.columns)} columns`
  if (search.total === 0) return 'No matches'
  return `${search.current >= 0 ? format(search.current + 1) : '–'} of ${format(search.total)}${search.partial ? '+' : ''} matches`
}

/** The search box's count: "3 of 1,204" (values), "2 of 40 columns" (columns), "No matches", or nothing before a search. */
export function searchCount(search: TabSearch, format: (n: number) => string): string {
  if (!search.text) return ''
  if (search.mode === 'columns') return `${format(search.total)} of ${format(search.columns)} columns`
  if (search.status === 'failed') return 'Search failed'
  if (search.total === 0) return search.status === 'searching' ? 'Searching…' : 'No matches'
  const more = search.partial || search.status === 'searching' ? '+' : ''
  return `${search.current >= 0 ? format(search.current + 1) : '–'} of ${format(search.total)}${more}`
}
