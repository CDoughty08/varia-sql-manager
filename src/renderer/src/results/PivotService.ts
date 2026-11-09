import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { draftSpec, emptyDraft, fitDraft as fitColumns, type PivotDraft, type PivotInfo } from './pivot'
import type { ResultSetEntry, ResultsService } from './ResultsService'
import { setKey } from './ResultsService'

/** One tab's pivot panel: whether it shows, the set it pivots, the draft, and the pivot running or the last failure. */
export interface PivotTab {
  readonly open: boolean
  readonly source: number
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
  private readonly unsubscribe: () => void

  constructor(results: Results) {
    super({ tabs: {}, info: new Map() })
    this.results = results
    this.unsubscribe = results.subscribe(() => this.sync())
  }

  /** Opens the panel on a grid's set (the one the command named or that has the focus). */
  open(tabId: string, index: number): void {
    const tab = this.results.getSnapshot()[tabId]
    if (!tab) return
    const current = this.getSnapshot().tabs[tabId]
    const source = tab.sets[index] && pivotable(tab.sets[index]) ? index : current?.source ?? index
    const draft = current && current.source === source ? current.draft : emptyDraft
    this.runs.set(tabId, tab.queryId)
    this.update(tabId, { open: true, source, draft: this.fit(tabId, source, draft), running: this.running.has(tabId), error: undefined })
  }

  close(tabId: string): void {
    const current = this.getSnapshot().tabs[tabId]
    if (current?.open) this.update(tabId, { ...current, open: false })
  }

  /** Points the panel at another set of the run; the draft is kept as far as the set's columns allow. */
  setSource(tabId: string, index: number): void {
    const current = this.getSnapshot().tabs[tabId]
    if (!current || current.source === index) return
    this.update(tabId, { ...current, source: index, draft: this.fit(tabId, index, current.draft), error: undefined })
  }

  setDraft(tabId: string, draft: PivotDraft): void {
    const current = this.getSnapshot().tabs[tabId]
    if (current) this.update(tabId, { ...current, draft: this.fit(tabId, current.source, draft), error: undefined })
  }

  /** Whether a grid's set can be pivoted now: its run has ended, its rows have all loaded, and no pivot runs in its tab. */
  canPivot(tabId: string, index: number): boolean {
    const tab = this.results.getSnapshot()[tabId]
    return !!tab && tab.status !== 'running' && tab.status !== 'closed' && !this.running.has(tabId) && pivotable(tab.sets[index])
  }

  /** Pivots the panel's set by its draft and appends the pivot to the run; a failure shows in the panel. */
  async run(tabId: string): Promise<void> {
    const state = this.getSnapshot().tabs[tabId]
    const tab = this.results.getSnapshot()[tabId]
    if (!state || !tab || !this.canPivot(tabId, state.source)) return
    const entry = tab.sets[state.source]
    const sort = this.results.sortOf(tabId, entry.index)
    // The grid's view when it shows one: the pivot reads its rows as the grid shows them.
    const handle = sort?.view ?? entry.handle
    const abort = new AbortController()
    const item = { abort, queryId: tab.queryId }
    this.running.set(tabId, item)
    this.update(tabId, { ...state, running: true, error: undefined })
    let error: string | undefined
    try {
      const result = await handle.pivot(draftSpec(this.fit(tabId, state.source, state.draft)), { signal: abort.signal })
      const sourceLabel = entry.label ?? `Result ${entry.index + 1}`
      const label = `Pivot of ${sourceLabel}`
      // Only the run that holds the set takes the pivot; otherwise (a re-run, a closed tab) it is released.
      if (this.results.addSet(tabId, result.descriptor, label, [setKey(entry.descriptor)]) === undefined) return
      const info: PivotInfo = {
        source: entry.index, sourceLabel, viewed: !!sort?.view, rows: result.rows, rowGroups: result.rowGroups,
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

  private fit(tabId: string, source: number, draft: PivotDraft): PivotDraft {
    const entry = this.results.getSnapshot()[tabId]?.sets[source]
    return entry ? fitColumns(draft, entry.descriptor.columns) : draft
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

  /** A new run (or a closed tab) gives up its tab's running pivot and starts its panel over on its first set. */
  private sync(): void {
    const snapshot = this.results.getSnapshot()
    for (const [tabId, item] of this.running) if (snapshot[tabId]?.queryId !== item.queryId) item.abort.abort()
    const current = this.getSnapshot()
    let tabs: Record<string, PivotTab> | undefined
    for (const [tabId, tab] of Object.entries(current.tabs)) {
      const run = snapshot[tabId]
      if (!run) { tabs ??= { ...current.tabs }; delete tabs[tabId]; this.runs.delete(tabId); continue }
      let next = tab
      // A new run keeps the draft (a re-run of the same query pivots the same way) and the set it pivots; the draft is fitted
      // to the set when it runs.
      if (this.runs.get(tabId) !== run.queryId) {
        this.runs.set(tabId, run.queryId)
        next = { open: tab.open, source: tab.source, draft: tab.draft, running: false }
      }
      // Once the run has ended without that set (or it is a diff), the panel moves to the first set it can pivot.
      const entry = run.sets[next.source]
      if (run.status !== 'running' && (!entry || entry.descriptor.kind === 'diff')) {
        const first = run.sets.findIndex(item => item.descriptor.kind === 'rows' || item.descriptor.kind === 'pivot')
        if (first >= 0 && first !== next.source) next = { ...next, source: first }
      }
      if (next !== tab) { tabs ??= { ...current.tabs }; tabs[tabId] = next }
    }
    if (tabs) this.publish({ tabs, info: this.shown(current.info) })
  }
}
