import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResultColumn } from '../../../shared/contracts'
import { draftSpec, emptyDraft, fitDraft as fitColumns, remapDraft, type PivotDraft, type PivotInfo } from './pivot'
import type { EntryKey, ResultSetEntry, ResultsService, TabResults } from './ResultsService'
import { entryName, entryOf, resultLimits, setKey } from './ResultsService'

/** One tab's pivot panel: whether it shows, the set it pivots (`source`: the key of the run's entry the service follows,
 *  undefined while the run does not have it), the draft, and the pivot running or the last failure. */
export interface PivotTab {
  readonly open: boolean
  readonly source: EntryKey | undefined
  /** The number of the original result the panel follows, which names it while a new run has yet to return it. */
  readonly sourceNumber?: number
  readonly draft: PivotDraft
  readonly running: boolean
  readonly error?: string
}
export interface PivotSnapshot {
  readonly tabs: Readonly<Record<string, PivotTab>>
  /** Each pivot set's strip, by its set key. */
  readonly info: ReadonlyMap<string, PivotInfo>
}

type Results = Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'sortOf'>
/** The entry a panel pivots: an original result by its number in the run, which the next run's result of that number takes
 *  over, or a derived entry (another pivot) by its key. */
type Source = { readonly ordinal: number } | { readonly key: EntryKey }
const sourceOf = (entry: ResultSetEntry): Source => entry.ordinal === undefined ? { key: entry.key } : { ordinal: entry.ordinal }
/** The entry of a run a panel follows, if the run has it. */
const followed = (sets: readonly ResultSetEntry[], source: Source | undefined): ResultSetEntry | undefined =>
  source === undefined ? undefined : 'key' in source ? entryOf(sets, source.key) : sets.find(entry => entry.ordinal === source.ordinal)

/** A set a pivot can read: rows (a query's, or another pivot's) that have all loaded. */
export const pivotable = (entry: ResultSetEntry | undefined): boolean =>
  entry !== undefined && (entry.descriptor.kind === 'rows' || entry.descriptor.kind === 'pivot') && entry.handle.getSnapshot().state === 'complete'

/**
 * Pivot (results PR 7): a grid's rows, as its sort and filters show them, grouped by row columns and a column group and
 * aggregated in the backend (results.pivot). The pivot is a new result of the run, appended as its last set and released
 * with the run's others, so its grid sorts, filters, copies and saves as any other. The panel's draft is kept per tab
 * until the run changes; a newer run (or none) gives up a pivot that is still running.
 */
export class PivotService extends SnapshotStore<PivotSnapshot> implements Disposable {
  private readonly results: Results
  private readonly running = new Map<string, { readonly abort: AbortController; readonly queryId: string }>()
  /** The run each tab's panel was set up for: a new run starts the draft over. */
  private readonly runs = new Map<string, string>()
  /** The columns each tab's draft was last fitted to: a draft follows its columns by name when they move. */
  private readonly fitted = new Map<string, readonly ResultColumn[]>()
  /** The entry each tab's panel pivots; the snapshot's `source` is its key in the run shown. */
  private readonly sources = new Map<string, Source>()
  private readonly unsubscribe: () => void

  constructor(results: Results) {
    super({ tabs: {}, info: new Map() })
    this.results = results
    this.unsubscribe = results.subscribe(() => this.sync())
  }

  /** Opens the panel on a grid's set (the one the command named or that has the focus). */
  open(tabId: string, key: EntryKey): void {
    const tab = this.results.getSnapshot()[tabId]
    if (!tab) return
    const current = this.getSnapshot().tabs[tabId]
    const entry = entryOf(tab.sets, key)
    // A grid that cannot be pivoted (a diff, one still loading) leaves the panel on the set it had.
    const source = entry && pivotable(entry) ? entry.key : current?.source ?? entry?.key
    const draft = current && current.source === source ? current.draft : emptyDraft
    this.runs.set(tabId, tab.queryId)
    this.update(tabId, { open: true, ...this.follow(tabId, tab, source), draft: this.fit(tabId, source, draft), running: this.running.has(tabId), error: undefined })
  }

  close(tabId: string): void {
    const current = this.getSnapshot().tabs[tabId]
    if (current?.open) this.update(tabId, { ...current, open: false })
  }

  /** Points the panel at another set of the run; the draft is kept as far as the set's columns allow. */
  setSource(tabId: string, key: EntryKey): void {
    const current = this.getSnapshot().tabs[tabId], tab = this.results.getSnapshot()[tabId]
    if (!current || !tab || current.source === key || !entryOf(tab.sets, key)) return
    this.update(tabId, { open: current.open, ...this.follow(tabId, tab, key), draft: this.fit(tabId, key, current.draft), running: current.running })
  }

  setDraft(tabId: string, draft: PivotDraft): void {
    const current = this.getSnapshot().tabs[tabId]
    if (current) this.update(tabId, { ...current, draft: this.fit(tabId, current.source, draft), error: undefined })
  }

  /** Whether a grid's set can be pivoted now: its run has ended, its rows have all loaded, its grid's sort or filter is built
   *  (as Save Results As waits for it: the pivot reads the rows the grid shows), and no pivot runs in its tab. */
  canPivot(tabId: string, key: EntryKey | undefined): boolean {
    const tab = this.results.getSnapshot()[tabId], entry = entryOf(tab?.sets, key)
    const sort = entry && this.results.sortOf(tabId, entry.key)
    return !!tab && tab.status !== 'running' && tab.status !== 'closed' && !this.running.has(tabId) && pivotable(entry)
      && !(sort && (sort.sorting || sort.stale || !sort.view))
  }

  /** Pivots the panel's set by its draft and appends the pivot to the run; a failure shows in the panel. */
  async run(tabId: string): Promise<void> {
    const state = this.getSnapshot().tabs[tabId]
    const tab = this.results.getSnapshot()[tabId]
    const entry = entryOf(tab?.sets, state?.source)
    if (!state || !tab || !entry || !this.canPivot(tabId, entry.key)) return
    const sort = this.results.sortOf(tabId, entry.key)
    // The grid's view when it shows one: the pivot reads its rows as the grid shows them.
    const handle = sort?.view ?? entry.handle
    const abort = new AbortController()
    const item = { abort, queryId: tab.queryId }
    this.running.set(tabId, item)
    this.update(tabId, { ...state, running: true, error: undefined })
    let error: string | undefined
    try {
      const result = await handle.pivot(draftSpec(this.fit(tabId, state.source, state.draft)), { signal: abort.signal })
      const sourceLabel = entryName(entry)
      const label = `Pivot of ${sourceLabel}`
      // Only the run that holds the set takes the pivot; otherwise (a re-run, a closed tab) it is released, and the panel says
      // why when its run is still the one it pivoted.
      if (this.results.addSet(tabId, result.descriptor, label, [setKey(entry.descriptor)]) === undefined) {
        const now = this.results.getSnapshot()[tabId]
        if (now?.queryId === tab.queryId) {
          error = now.sets.length >= resultLimits.sets
            ? `These results already show ${resultLimits.sets.toLocaleString('en-US')} sets, so the pivot was not added. Close Results or run the query again.`
            : 'These results were closed, so the pivot was not added.'
        }
        return
      }
      const info: PivotInfo = {
        source: entry.key, sourceLabel, viewed: !!sort?.view, rows: result.rows, rowGroups: result.rowGroups,
        columnGroups: result.columnGroups, approximate: result.approximate
      }
      const snapshot = this.getSnapshot()
      this.publish({ tabs: snapshot.tabs, info: new Map([...this.shown(snapshot.info), [setKey(result.descriptor), info]]) })
    } catch (failure) {
      if (!abort.signal.aborted) error = failure instanceof Error ? failure.message : 'The results could not be pivoted.'
    } finally {
      if (this.running.get(tabId) === item) {
        this.running.delete(tabId)
        const current = this.getSnapshot().tabs[tabId]
        if (current) this.update(tabId, { ...current, running: false, ...(error ? { error } : {}) })
      }
    }
  }

  /** Stops a tab's running pivot. */
  cancel(tabId: string): void { this.running.get(tabId)?.abort.abort() }

  dispose(): void {
    this.unsubscribe()
    for (const item of this.running.values()) item.abort.abort()
    this.running.clear()
    this.clearListeners()
  }

  /** The panel follows the entry `key` from now on; what the snapshot says of it. */
  private follow(tabId: string, tab: TabResults, key: EntryKey | undefined): Pick<PivotTab, 'source' | 'sourceNumber'> {
    const entry = entryOf(tab.sets, key)
    if (!entry) { this.sources.delete(tabId); return { source: undefined } }
    this.sources.set(tabId, sourceOf(entry))
    return { source: entry.key, ...entry.ordinal === undefined ? {} : { sourceNumber: entry.ordinal } }
  }

  private fit(tabId: string, source: EntryKey | undefined, draft: PivotDraft): PivotDraft {
    const columns = entryOf(this.results.getSnapshot()[tabId]?.sets, source)?.descriptor.columns
    if (!columns) return draft
    const previous = this.fitted.get(tabId)
    this.fitted.set(tabId, columns)
    return fitColumns(previous && previous !== columns ? remapDraft(draft, previous, columns) : draft, columns)
  }

  private update(tabId: string, tab: PivotTab): void {
    const snapshot = this.getSnapshot()
    this.publish({ tabs: { ...snapshot.tabs, [tabId]: tab }, info: snapshot.info })
  }

  /** Only pivots some run still shows keep their strips. */
  private shown(info: ReadonlyMap<string, PivotInfo>): Map<string, PivotInfo> {
    const shown = new Set(Object.values(this.results.getSnapshot()).flatMap(run => run.sets.map(entry => setKey(entry.descriptor))))
    return new Map([...info].filter(([key]) => shown.has(key)))
  }

  /** A new run (or a closed tab) gives up its tab's running pivot; the panel keeps its set while the run has it. */
  private sync(): void {
    const snapshot = this.results.getSnapshot()
    for (const [tabId, item] of this.running) if (snapshot[tabId]?.queryId !== item.queryId) item.abort.abort()
    const current = this.getSnapshot()
    let tabs: Record<string, PivotTab> | undefined
    for (const [tabId, tab] of Object.entries(current.tabs)) {
      const run = snapshot[tabId]
      if (!run) { tabs ??= { ...current.tabs }; delete tabs[tabId]; this.runs.delete(tabId); this.fitted.delete(tabId); this.sources.delete(tabId); continue }
      let next = tab
      // A new run keeps the draft (a re-run of the same query pivots the same way) and the set it pivots; the draft is fitted
      // to the set when it runs.
      if (this.runs.get(tabId) !== run.queryId) {
        this.runs.set(tabId, run.queryId)
        next = { open: tab.open, source: tab.source, ...tab.sourceNumber === undefined ? {} : { sourceNumber: tab.sourceNumber }, draft: tab.draft, running: false }
      }
      // The set it pivots is an entry, not a place: an original result is found again by its number in a new run, a derived
      // one only by its key, in the run that made it.
      let entry = followed(run.sets, this.sources.get(tabId))
      // Once the run has ended without that set (or it is a diff), the panel moves to the first set it can pivot. While the
      // run goes on, a result it has yet to return keeps the panel.
      if (run.status !== 'running' && (!entry || entry.descriptor.kind === 'diff')) {
        const first = run.sets.find(item => item.descriptor.kind === 'rows' || item.descriptor.kind === 'pivot')
        if (first) { entry = first; next = { open: next.open, ...this.follow(tabId, run, first.key), draft: next.draft, running: next.running, ...next.error ? { error: next.error } : {} } }
      }
      if (next.source !== entry?.key) next = { ...next, source: entry?.key }
      // Once the set's columns are known the draft follows them by name, so a re-run that moves them keeps what it grouped.
      const columns = entry?.descriptor.columns
      if (columns && this.fitted.get(tabId) !== columns) next = { ...next, draft: this.fit(tabId, next.source, next.draft) }
      if (next !== tab) { tabs ??= { ...current.tabs }; tabs[tabId] = next }
    }
    // Strips of pivots no run shows any more go, whether or not a panel changed (Close Results changes none).
    const info = current.info.size ? this.shown(current.info) : current.info
    if (tabs || info.size !== current.info.size) this.publish({ tabs: tabs ?? current.tabs, info })
  }
}
