import type { ResultColumn } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable } from '../core/types'
import type { RowHighlights } from '../grid/highlights'
import { resolveBlocks } from '../grid/selection'
import type { ResultHandle } from './ResultClient'
import { entryOf, type EntryKey, type ResultSetEntry, type ResultsService, type TabResults } from './ResultsService'
import { formatCount } from './status'

/** One result set's highlights as the grid and its strip show them. */
export interface SetHighlights {
  /** Rows highlighted (their identities), whether or not this run has them. */
  readonly count: number
  /** How many of them this run has. */
  readonly found: number
  /** The column they follow, '' for the whole row; undefined until the first highlight told the rows apart. */
  readonly by?: string
  /** Whether no two rows of this run share an identity: when false, one highlight can cover several rows. */
  readonly unique: boolean
  /** The column the highlights follow when this run's result has no such column, so none of its rows can be found. */
  readonly lacks?: string
  /** With `lacks`: the result has several such columns, none at the old position, so which one is not known. */
  readonly ambiguous?: boolean
  /** More rows have the highlights than one search lists (results.findRows' limit): only the first are drawn. */
  readonly truncated: boolean
  /** The rows to draw, one set per handle the grid may show (the result's, and its sorted view's). */
  readonly rows: readonly RowHighlights[]
}
/** Each tab's highlights by entry key, for the grids: those of the entries its run has now. */
export type HighlightsSnapshot = Readonly<Record<string, ReadonlyMap<EntryKey, SetHighlights>>>
/** What a set of highlights belongs to: an original result's number in its run (a number), which the next run's result of
 *  that number takes over, or a derived entry's key (a string), which goes with that entry. */
type Owner = number | EntryKey
const ownerOf = (entry: ResultSetEntry): Owner => entry.ordinal ?? entry.key
/** The entry that has an owner's highlights now: the run's original result of that number, or the derived entry itself. */
function owned(sets: readonly ResultSetEntry[], owner: Owner): ResultSetEntry | undefined {
  return typeof owner === 'string' ? entryOf(sets, owner) : sets.find(entry => entry.ordinal === owner)
}

/** How a set's highlights tell rows apart, chosen when its first row is highlighted and kept through re-runs. A column is
 *  kept by its name, type and position, since a result may have several columns of one name (or none named). */
type TrackBy = { readonly column: string; readonly dataType: string; readonly ordinal: number } | { readonly row: true }

/** Types whose length, precision or scale may change without changing how the backend hashes a value: text by its
 *  characters, decimals by their digits, binary by its bytes. Any other type must stay the same to the letter. */
const resizable = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'decimal', 'numeric', 'binary', 'varbinary'])
/** The type compared across re-runs: nvarchar(60) is nvarchar, but datetime2(3) stays datetime2(3). */
const trackedType = (dataType: string) => {
  const type = dataType.trim().toLowerCase(), base = type.replace(/\(.*$/, '').trim()
  return resizable.has(base) ? base : type
}

/** The column a re-run's result has for the one highlights follow: the same name and type (a length may change), at the
 *  same position, or the only such column anywhere. -1 when there is none, -2 when there are several and picking one
 *  would be a guess. */
export function trackedColumn(columns: readonly ResultColumn[], by: { readonly column: string; readonly dataType: string; readonly ordinal: number }): number {
  const type = trackedType(by.dataType)
  const same = (column: ResultColumn | undefined) => column !== undefined && column.name === by.column && trackedType(column.dataType) === type
  if (same(columns[by.ordinal])) return by.ordinal
  const matches = columns.flatMap((column, at) => same(column) ? [at] : [])
  return matches.length === 1 ? matches[0] : matches.length === 0 ? -1 : -2
}
/** A set's highlights bound to one run's result: the identities the backend computed for it (results.identify). */
interface Binding {
  readonly handle: ResultHandle
  readonly abort: AbortController
  /** Resolves true once the result's rows have identities, false when they cannot (the key column is gone, or it failed). */
  readonly ready: Promise<boolean>
  column: number
  unique: boolean
  /** The column highlights follow, when this result has none like it (or, `ambiguous`, several). */
  readonly lacks?: string
  readonly ambiguous?: boolean
}
interface Marks {
  by?: TrackBy
  /** Each highlighted identity's colour, 1-based (highlightColors). */
  readonly colors: Map<number, number>
  bound?: Binding
  /** Bumped by every change of `colors`; a handle's rows are found again for a newer one. */
  version: number
  /** The entry the highlights were last published for (undefined: none), so they are published again when another has them. */
  at: EntryKey | undefined
  /** Rows found per handle, and the version they were found for. */
  readonly found: Map<ResultHandle, { readonly version: number; readonly rows: RowHighlights; readonly marks: number; readonly truncated: boolean }>
  /** Searches in flight, by handle. */
  readonly finding: Map<ResultHandle, number>
  /** Searches that failed, by handle and version: not tried again until the highlights or the shown handle change, the
   *  user highlights again, or (for a passing error) a retry's backoff ends. */
  readonly failed: Map<ResultHandle, number>
  /** Retries since the last search that succeeded, and the one waiting. */
  retries: number
  retry?: unknown
}

/** The most rows one Highlight command marks, the most highlights a result set keeps and rows one search lists
 *  (results.findRows' limits), and the waits before a failed search is tried again after a passing error. */
export const highlightLimits = { rowsPerCommand: wire.identity.maxFind, perSet: wire.identity.maxFind, drawn: wire.identity.maxMatches, retryMs: [1_000, 4_000, 16_000] } as const
/** Errors that pass on their own (the backend or the port busy, a deadline), worth a retry. */
const passing = new Set(['BUSY', 'TOO_MANY_REQUESTS', 'TIMEOUT'])
const complete = (entry: ResultSetEntry | undefined): entry is ResultSetEntry => entry?.handle.getSnapshot().state === 'complete'

/**
 * Row highlights in each query tab's grids (results PR 8). A highlight belongs to the tab and to its result: an original
 * result's by its number in the run, so they follow re-runs of the query; a derived entry's (a pivot, a diff)
 * by the entry, so they go with it. It follows its row by identity: a unique key column the backend picks, else the whole
 * row's values (results.identify), hashed by collation, so it stays on its row through sorting and re-runs. Rows are found in the backend
 * (results.findRows) for the handle each grid shows; the grid draws them from theme colours (GridView.setHighlights).
 * Highlights are kept in memory only: they go with the tab, and do not survive hot exit.
 */
export class HighlightsService extends SnapshotStore<HighlightsSnapshot> implements Disposable {
  private readonly tabs = new Map<string, Map<Owner, Marks>>()
  private readonly results: Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'sortOf' | 'selection' | 'notify'>
  private readonly timers: Timers
  private readonly unsubscribe: () => void
  private scheduled = false
  private disposed = false

  constructor(results: Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'sortOf' | 'selection' | 'notify'>, o: { timers?: Timers } = {}) {
    super({})
    this.results = results
    this.timers = o.timers ?? browserTimers
    this.unsubscribe = results.subscribe(() => this.resultsChanged())
  }

  /** Whether a grid's rows can be highlighted: its set has every row and is still held. */
  canHighlight(tabId: string, key: EntryKey): boolean { return complete(this.entry(tabId, key)) }

  /** Whether a grid has highlights (Clear All Highlights). */
  hasHighlights(tabId: string, key: EntryKey): boolean {
    const entry = this.entry(tabId, key)
    return !!entry && (this.tabs.get(tabId)?.get(ownerOf(entry))?.colors.size ?? 0) > 0
  }

  /** The rows a grid draws (GridView.setHighlights). */
  rowsFor(tabId: string, key: EntryKey): readonly RowHighlights[] {
    const entry = this.entry(tabId, key)
    return (entry && this.getSnapshot()[tabId]?.get(entry.key)?.rows) ?? []
  }

  /**
   * Highlights the grid's selected rows with `color` (1-based), or takes their highlight away with 0. A colour every selected
   * row already has is taken away instead, so the same command turns it off. Resolves once the grid can draw the change.
   */
  async highlight(tabId: string, key: EntryKey, color: number): Promise<void> {
    const entry = this.entry(tabId, key)
    if (!entry) return
    const index = ownerOf(entry)
    // The user acting is a reason to search again for rows a failed search did not find: at once, unless the command
    // changes the highlights, which searches anyway.
    const existing = this.marksOf(tabId, index)
    const retry = existing !== undefined && existing.failed.size > 0, version = existing?.version
    if (retry) {
      this.stopRetry(existing)
      existing.failed.clear()
      existing.retries = 0
    }
    try { await this.mark(tabId, index, color) }
    finally { if (retry && existing.version === version && this.marksOf(tabId, index) === existing) void this.refresh(tabId, index) }
  }

  private async mark(tabId: string, index: Owner, color: number): Promise<void> {
    const entry = this.owned(tabId, index)
    if (!complete(entry)) return
    const selection = this.results.selection(tabId, entry.key)
    const shown = this.shownHandle(tabId, entry)
    const blocks = selection ? resolveBlocks(selection, shown.getSnapshot().rowsAvailable, entry.descriptor.columns.length) : []
    const ranges = mergeRows(blocks.map(block => [block.top, block.bottom] as const))
    const total = ranges.reduce((sum, [first, last]) => sum + last - first + 1, 0)
    if (total === 0) return
    if (total > highlightLimits.rowsPerCommand) return this.results.notify(tabId, `Highlight up to ${formatCount(highlightLimits.rowsPerCommand)} rows at a time.`)
    const marks = this.marksOf(tabId, index, true)
    const binding = this.bind(tabId, index, marks, entry)
    try {
      if (!await binding.ready || marks.bound !== binding) {
        if (binding.lacks !== undefined && marks.bound === binding) this.results.notify(tabId, lacksText(marks.colors.size, binding.lacks, binding.ambiguous))
        return
      }
      const ids: number[] = []
      for (const [first, last] of ranges) {
        for (let row = first; row <= last; row += wire.identity.maxRows) {
          const answer = await shown.rowIds(row, Math.min(wire.identity.maxRows, last - row + 1), binding.abort.signal)
          for (const id of answer.ids) if (id >= 0) ids.push(id)
        }
      }
      if (marks.bound !== binding || ids.length === 0) return
      const off = color === 0 || ids.every(id => marks.colors.get(id) === color)
      const added = off ? 0 : new Set(ids.filter(id => !marks.colors.has(id))).size
      if (marks.colors.size + added > highlightLimits.perSet) return this.results.notify(tabId, `A result keeps up to ${formatCount(highlightLimits.perSet)} highlights. Clear some first.`)
      for (const id of ids) {
        if (off) marks.colors.delete(id)
        else marks.colors.set(id, color)
      }
      marks.version++
      await this.refresh(tabId, index)
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      this.results.notify(tabId, 'Could not highlight the rows: ' + (error instanceof Error ? error.message : 'The rows could not be told apart.'))
    }
  }

  /** Takes every highlight off a grid. */
  clear(tabId: string, key: EntryKey): void {
    const entry = this.entry(tabId, key), index = entry && ownerOf(entry)
    const marks = index === undefined ? undefined : this.tabs.get(tabId)?.get(index)
    if (!marks || index === undefined) return
    marks.bound?.abort.abort()
    this.stopRetry(marks)
    this.tabs.get(tabId)!.delete(index)
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    for (const sets of this.tabs.values()) for (const marks of sets.values()) { marks.bound?.abort.abort(); this.stopRetry(marks) }
    this.tabs.clear()
    this.clearListeners()
  }

  /** The entry a grid's reference names, in the results as last published. */
  private entry(tabId: string, key: EntryKey): ResultSetEntry | undefined { return entryOf(this.results.getSnapshot()[tabId]?.sets, key) }
  /** The entry that has an owner's highlights now. */
  private owned(tabId: string, owner: Owner): ResultSetEntry | undefined {
    const sets = this.results.getSnapshot()[tabId]?.sets
    return sets && owned(sets, owner)
  }

  private marksOf(tabId: string, index: Owner, create: true): Marks
  private marksOf(tabId: string, index: Owner, create?: false): Marks | undefined
  private marksOf(tabId: string, index: Owner, create = false): Marks | undefined {
    let sets = this.tabs.get(tabId)
    if (!sets && create) this.tabs.set(tabId, sets = new Map())
    let marks = sets?.get(index)
    if (!marks && create) sets!.set(index, marks = { colors: new Map(), version: 0, at: undefined, found: new Map(), finding: new Map(), failed: new Map(), retries: 0 })
    return marks
  }

  /** The handle the grid shows: its sorted view while it has one (the order its selection counts in), else its result. */
  private shownHandle(tabId: string, entry: ResultSetEntry): ResultHandle {
    const view = this.results.sortOf(tabId, entry.key)?.view
    return view && view.base === entry.handle ? view : entry.handle
  }

  /** Binds a set's highlights to a run's result, telling its rows apart the way they were first told apart. */
  private bind(tabId: string, index: Owner, marks: Marks, entry: ResultSetEntry): Binding {
    if (marks.bound?.handle === entry.handle) return marks.bound
    marks.bound?.abort.abort()
    marks.found.clear()
    marks.finding.clear()
    marks.failed.clear()
    this.stopRetry(marks)
    marks.retries = 0
    const abort = new AbortController()
    const by = marks.by
    const column = by && 'column' in by ? trackedColumn(entry.descriptor.columns, by) : undefined
    const binding: Binding = {
      handle: entry.handle, abort, column: column ?? -1, unique: true,
      ...column !== undefined && column < 0 && by && 'column' in by ? { lacks: by.column || '(No column name)', ...column === -2 ? { ambiguous: true } : {} } : {},
      ready: column !== undefined && column < 0 ? Promise.resolve(false) : entry.handle.identify(!by ? 'auto' : 'row' in by ? 'row' : 'column', { ...column === undefined ? {} : { column }, signal: abort.signal }).then(result => {
        if (marks.bound !== binding) return false
        binding.column = result.column
        binding.unique = result.unique
        const picked = entry.descriptor.columns[result.column]
        marks.by ??= result.column < 0 || !picked ? { row: true } : { column: picked.name, dataType: picked.dataType, ordinal: result.column }
        return true
      }, error => {
        if (marks.bound === binding && (error as Error).name !== 'AbortError')
          this.results.notify(tabId, 'Could not find the highlighted rows: ' + (error instanceof Error ? error.message : 'The rows could not be told apart.'))
        return false
      })
    }
    marks.bound = binding
    void binding.ready.then(ready => { if (ready && marks.bound === binding) void this.refresh(tabId, index) })
    this.schedule()
    return binding
  }

  /** Finds the highlighted rows for each handle the grid may show whose rows are older than the highlights. */
  private async refresh(tabId: string, index: Owner): Promise<void> {
    const marks = this.marksOf(tabId, index), entry = this.owned(tabId, index)
    const binding = marks?.bound
    if (!marks || !binding || !entry || binding.handle !== entry.handle || !await binding.ready || marks.bound !== binding) return this.schedule()
    const handles = new Set([entry.handle, this.shownHandle(tabId, entry)])
    const ids = [...marks.colors.keys()], version = marks.version
    await Promise.all([...handles].map(async handle => {
      if (marks.found.get(handle)?.version === version || marks.finding.get(handle) === version || marks.failed.get(handle) === version) return
      if (ids.length === 0) {
        marks.found.set(handle, { version, rows: { handle, positions: new Float64Array(0), colors: new Uint8Array(0) }, marks: 0, truncated: false })
        return
      }
      marks.finding.set(handle, version)
      try {
        const found = await handle.findRows(ids, binding.abort.signal)
        if (marks.bound !== binding || marks.version !== version) return
        const colors = Uint8Array.from(found.marks, mark => marks.colors.get(ids[mark]) ?? 0)
        marks.found.set(handle, { version, rows: { handle, positions: Float64Array.from(found.positions), colors }, marks: new Set(found.marks).size, truncated: found.truncated })
        marks.retries = 0
      } catch (error) {
        if ((error as Error).name === 'AbortError' || marks.bound !== binding) return
        // Remembered so the notice's own snapshot (resultsChanged) does not search again, and again, while the error lasts.
        marks.failed.set(handle, version)
        const code = (error as { code?: unknown }).code
        // A passing error is tried again a few times, each after a longer wait; one that comes while a retry waits (another
        // handle's search) waits for that retry too, rather than tell the user of a failure about to be retried.
        if (typeof code === 'string' && passing.has(code) && marks.retry !== undefined) return
        if (typeof code === 'string' && passing.has(code) && marks.retries < highlightLimits.retryMs.length) {
          marks.retry = this.timers.setTimeout(() => {
            marks.retry = undefined
            if (this.disposed || marks.bound !== binding) return
            marks.failed.clear()
            void this.refresh(tabId, index)
          }, highlightLimits.retryMs[marks.retries++])
          return
        }
        this.results.notify(tabId, 'Could not find the highlighted rows: ' + (error instanceof Error ? error.message : 'The search failed.'))
      } finally {
        if (marks.finding.get(handle) === version) marks.finding.delete(handle)
      }
    }))
    // Rows found for handles the grid no longer shows go.
    for (const handle of [...marks.found.keys()]) if (!handles.has(handle)) marks.found.delete(handle)
    for (const handle of [...marks.failed.keys()]) if (!handles.has(handle)) marks.failed.delete(handle)
    this.schedule()
  }

  private stopRetry(marks: Marks): void {
    if (marks.retry !== undefined) this.timers.clearTimeout(marks.retry)
    marks.retry = undefined
  }

  /** Re-runs bind their tab's highlights to the new results once they are complete; a new sort finds its rows. */
  private resultsChanged(): void {
    if (this.disposed || this.tabs.size === 0) return
    const snapshot = this.results.getSnapshot()
    let changed = false
    for (const [tabId, sets] of this.tabs) {
      const tab: TabResults | undefined = snapshot[tabId]
      if (!tab) {
        for (const marks of sets.values()) { marks.bound?.abort.abort(); this.stopRetry(marks) }
        this.tabs.delete(tabId)
        changed = true
        continue
      }
      for (const [index, marks] of sets) {
        const entry = owned(tab.sets, index)
        // A derived entry's highlights go with it: no later entry takes them over.
        if (!entry && typeof index === 'string') {
          marks.bound?.abort.abort()
          this.stopRetry(marks)
          sets.delete(index)
          changed = true
          continue
        }
        if (entry?.key !== marks.at) changed = true
        // Its result went (it was closed, or a new run began): what was asked of that result lands nowhere and says
        // nothing. The highlights stay for the next result of that number, which binds them again.
        if (!entry && marks.bound) {
          marks.bound.abort.abort()
          this.stopRetry(marks)
          marks.bound = undefined
          marks.finding.clear()
          marks.failed.clear()
          changed = true
        }
        if (!complete(entry)) {
          if (marks.found.size > 0) { marks.found.clear(); changed = true }
          continue
        }
        if (marks.colors.size === 0) continue
        if (marks.bound?.handle !== entry.handle) { this.bind(tabId, index, marks, entry); continue }
        const shown = this.shownHandle(tabId, entry)
        if (!marks.found.has(shown) && !marks.finding.has(shown) && marks.failed.get(shown) !== marks.version) void this.refresh(tabId, index)
      }
    }
    if (changed) this.schedule()
  }

  /** Publishes once per task, so a burst of answers draws once. */
  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.disposed) this.publish(this.build())
    })
  }

  private build(): HighlightsSnapshot {
    const next: Record<string, ReadonlyMap<EntryKey, SetHighlights>> = {}
    const results = this.results.getSnapshot()
    for (const [tabId, sets] of this.tabs) {
      const shown = new Map<EntryKey, SetHighlights>()
      const entries = results[tabId]?.sets ?? []
      for (const [owner, marks] of sets) {
        // Highlights kept for a result this run has not returned (yet) are drawn nowhere until it does.
        const index = marks.at = owned(entries, owner)?.key
        if (index === undefined || (marks.colors.size === 0 && !marks.by)) continue
        const found = [...marks.found.values()]
        const base = marks.bound && marks.found.get(marks.bound.handle)
        const by = marks.by ? ('column' in marks.by ? marks.by.column || '(No column name)' : '') : undefined
        const lacks = marks.bound?.lacks
        shown.set(index, {
          count: marks.colors.size, found: base?.marks ?? 0, ...by === undefined ? {} : { by }, unique: marks.bound?.unique ?? true,
          ...lacks === undefined ? {} : { lacks, ...marks.bound?.ambiguous ? { ambiguous: true } : {} },
          truncated: base?.truncated ?? false, rows: found.map(item => item.rows)
        })
      }
      if (shown.size > 0) next[tabId] = shown
    }
    return next
  }
}

const lacksText = (count: number, column: string, ambiguous = false) =>
  `${formatCount(count)} ${count === 1 ? 'highlight follows' : 'highlights follow'} ${column}, ${ambiguous ? 'which these results have more than once, in other places' : 'which these results lack'}. Clear All Highlights to highlight rows here.`

/** What the strip says of a set's highlights: a key column these results lack (nothing can be found or highlighted), more
 *  rows than one search draws, those this run lacks (kept, they return with their rows), or a key that is not unique here
 *  (one highlight covers every row with its value). */
export function highlightText(marked: SetHighlights | undefined): string | undefined {
  if (!marked || marked.count === 0) return undefined
  if (marked.lacks !== undefined) return lacksText(marked.count, marked.lacks, marked.ambiguous)
  if (marked.truncated) return `More than ${formatCount(highlightLimits.drawn)} rows have these highlights; only the first ${formatCount(highlightLimits.drawn)} are drawn.`
  const missing = marked.count - marked.found
  if (missing > 0 && marked.rows.length > 0) return `${formatCount(missing)} highlighted ${missing === 1 ? 'row is' : 'rows are'} not in these results. ${missing === 1 ? 'It stays' : 'They stay'} highlighted for when ${missing === 1 ? 'it returns' : 'they return'}.`
  if (!marked.unique && marked.found > 0) return marked.by ? `${marked.by} is not unique in these results, so a highlight can cover several rows.` : 'Some rows here are identical, so a highlight covers each of them.'
  return undefined
}

/** Inclusive row ranges, sorted and merged where they touch or overlap. */
export function mergeRows(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [first, last] of sorted) {
    const tail = merged[merged.length - 1]
    if (tail && first <= tail[1] + 1) tail[1] = Math.max(tail[1], last)
    else merged.push([first, last])
  }
  return merged
}
