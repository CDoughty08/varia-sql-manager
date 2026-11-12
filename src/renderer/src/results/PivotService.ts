import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResultColumn } from '../../../shared/contracts'
import { draftSpec, emptyDraft, fitDraft as fitColumns, remapDraft, type PivotDraft, type PivotInfo } from './pivot'
import type { EntryKey, ResultGroup, ResultSetEntry, ResultsService, TabResults } from './ResultsService'
import { entryName, groupOf, resultLimits, setKey, slotOf } from './ResultsService'

/** One tab's pivot builder: whether it shows, the group it belongs to (`source`: the key of that group's Table in the run
 *  shown, undefined while the run does not have it), the group's draft, and the pivot running or the last failure. */
export interface PivotTab {
  readonly open: boolean
  readonly source: EntryKey | undefined
  /** The name of the result the builder follows ("Result 2"), which it shows while a new run does not have it. */
  readonly sourceName?: string
  /** The group's Pivot now, which building again replaces. */
  readonly pivot?: EntryKey
  readonly draft: PivotDraft
  readonly running: boolean
  readonly error?: string
}
export interface PivotSnapshot {
  readonly tabs: Readonly<Record<string, PivotTab>>
  /** Each pivot set's strip, by its set key. */
  readonly info: ReadonlyMap<string, PivotInfo>
}

type Results = Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'sortOf' | 'removeEntry'>

/** A set a pivot can read: a query's rows that have all loaded. Never a pivot, a transpose, a comparison or a plan set. */
export const pivotable = (entry: ResultSetEntry | undefined): boolean =>
  entry !== undefined && entry.descriptor.kind === 'rows' && entry.handle.getSnapshot().state === 'complete'
/** A group a builder can belong to: one whose Table holds a query's rows (not a SQL-returned plan set). */
const buildable = (group: ResultGroup | undefined): group is ResultGroup => !!group && !group.planSet && group.table.entry.descriptor.kind === 'rows'
/**
 * The group Pivot acts on for the grid of entry `key`: the group whose Table or Pivot it shows. A comparison, a plan set,
 * a stored transpose and any grid of a bare run (Peek) have none, so Pivot is not offered there.
 */
export function pivotGroup(tab: TabResults | undefined, key: EntryKey | undefined): ResultGroup | undefined {
  if (!tab || tab.bare) return undefined
  const view = slotOf(tab, key)?.view, group = groupOf(tab, key)
  return (view === 'table' || view === 'pivot') && buildable(group) ? group : undefined
}

/**
 * Pivot: a group's Table, as its grid's filters show it, grouped by row columns and a column group and aggregated in the
 * backend (results.pivot). The pivot is the group's Pivot: a result of the run drawn directly under the Table and released
 * with the group, whose grid sorts, filters, copies and saves as any other. A group has one, and it is always read from
 * the Table, so building again replaces it: the old one is released first and the new one shown when it is built (not yet
 * atomically: a build that fails or is cancelled leaves the group without a Pivot). The builder belongs to one group: the
 * one whose grid last had the focus, or the first that can be pivoted when that grid is a comparison or a plan set. Each
 * group keeps a draft of its own, which a new run's group of the same number takes over, fitted to its columns by name. A
 * newer run (or none) gives up a pivot that is still running.
 */
export class PivotService extends SnapshotStore<PivotSnapshot> implements Disposable {
  private readonly results: Results
  /** The pivot each tab builds, with the run and the Table it reads: a newer run, or that Table closed, gives it up. */
  private readonly running = new Map<string, { readonly abort: AbortController; readonly queryId: string; readonly source: EntryKey }>()
  /** The run each tab's builder was set up for. */
  private readonly runs = new Map<string, string>()
  /** The group each tab's builder belongs to, by ordinal: the next run's result of that number takes it over. */
  private readonly groups = new Map<string, number>()
  /** Each group's draft, by tab and ordinal, with the columns it was last fitted to: a draft follows its columns by name
   *  when they move. */
  private readonly drafts = new Map<string, Map<number, { readonly draft: PivotDraft; readonly columns?: readonly ResultColumn[] }>>()
  /** The focused entry each tab's builder last followed: it moves only when the focus does. */
  private readonly focus = new Map<string, EntryKey | undefined>()
  private readonly unsubscribe: () => void

  constructor(results: Results) {
    super({ tabs: {}, info: new Map() })
    this.results = results
    this.unsubscribe = results.subscribe(() => this.sync())
  }

  /** Opens the builder on the group of a grid (the one the command named or that has the focus): on the group whose Table
   *  or Pivot it shows, else on the group the builder had, else on the first that can be pivoted. */
  open(tabId: string, key?: EntryKey): void {
    const tab = this.results.getSnapshot()[tabId]
    if (!tab || tab.bare) return
    const current = this.getSnapshot().tabs[tabId]
    const ordinal = pivotGroup(tab, key)?.ordinal ?? this.kept(tab, this.groups.get(tabId)) ?? tab.groups.find(buildable)?.ordinal
    this.runs.set(tabId, tab.queryId)
    this.focus.set(tabId, tab.focused)
    this.update(tabId, this.tabOf(tabId, tab, ordinal, { open: true, running: this.running.has(tabId) || !!current?.running }))
  }

  close(tabId: string): void {
    const current = this.getSnapshot().tabs[tabId]
    if (current?.open) this.update(tabId, { ...current, open: false })
  }

  setDraft(tabId: string, draft: PivotDraft): void {
    const current = this.getSnapshot().tabs[tabId], ordinal = this.groups.get(tabId), tab = this.results.getSnapshot()[tabId]
    if (!current || ordinal === undefined) return
    const columns = tab?.groups.find(group => group.ordinal === ordinal)?.table.entry.descriptor.columns
    let drafts = this.drafts.get(tabId)
    if (!drafts) this.drafts.set(tabId, drafts = new Map())
    const fitted = columns ? fitColumns(draft, columns) : draft
    drafts.set(ordinal, { draft: fitted, ...columns ? { columns } : {} })
    const { error: _error, ...rest } = current
    this.update(tabId, { ...rest, draft: fitted })
  }

  /** Whether the group of a grid can be pivoted now: the grid shows the group's Table or Pivot, the run has ended, the
   *  Table's rows have all loaded, its sort or filter is built (as Save Results As waits for it: the pivot reads the rows
   *  the Table's grid shows), and no pivot runs in its tab. */
  canPivot(tabId: string, key: EntryKey | undefined): boolean {
    const tab = this.results.getSnapshot()[tabId], entry = pivotGroup(tab, key)?.table.entry
    const sort = entry && this.results.sortOf(tabId, entry.key)
    return !!tab && tab.status !== 'running' && tab.status !== 'closed' && !this.running.has(tabId) && pivotable(entry)
      && !(sort && (sort.sorting || sort.stale || !sort.view))
  }

  /** Pivots the builder's group by its draft and shows the pivot as the group's Pivot, in place of the one it had; a
   *  failure shows in the builder. */
  async run(tabId: string): Promise<void> {
    const state = this.getSnapshot().tabs[tabId]
    const tab = this.results.getSnapshot()[tabId]
    const group = tab?.groups.find(item => item.ordinal === this.groups.get(tabId)), entry = group?.table.entry
    if (!state || !tab || !group || !entry || !this.canPivot(tabId, entry.key)) return
    const sort = this.results.sortOf(tabId, entry.key)
    // The Table's view when its grid shows one: the pivot reads its rows as the grid shows them.
    const handle = sort?.view ?? entry.handle
    const abort = new AbortController()
    const item = { abort, queryId: tab.queryId, source: entry.key }
    this.running.set(tabId, item)
    // A group has one Pivot: the one it has is released before the new one is built.
    if (group.pivot) this.results.removeEntry(tabId, group.pivot.key)
    const { error: _error, ...rest } = this.getSnapshot().tabs[tabId] ?? state
    this.update(tabId, { ...rest, running: true })
    let error: string | undefined
    try {
      const result = await handle.pivot(draftSpec(state.draft), { signal: abort.signal })
      const sourceLabel = entryName(entry)
      const label = `Pivot of ${sourceLabel}`
      // Only the run that holds the Table takes the pivot; otherwise (a re-run, a closed tab) it is released, and the
      // builder says why when its run is still the one it pivoted.
      if (this.results.addSet(tabId, result.descriptor, label, [setKey(entry.descriptor)]) === undefined) {
        const now = this.results.getSnapshot()[tabId]
        // A Table closed while its pivot was built gave the pivot up: the builder has moved on and says nothing of it.
        if (now?.queryId === tab.queryId && !abort.signal.aborted) {
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

  /** The ordinal, while the run has a group of it that can be pivoted, or may yet return one. */
  private kept(tab: TabResults, ordinal: number | undefined): number | undefined {
    if (ordinal === undefined) return undefined
    const group = tab.groups.find(item => item.ordinal === ordinal)
    return buildable(group) || (!group && tab.status === 'running') ? ordinal : undefined
  }

  /** The builder's state on the group `ordinal` of a run, which it belongs to from now on. */
  private tabOf(tabId: string, tab: TabResults, ordinal: number | undefined, rest: Pick<PivotTab, 'open' | 'running' | 'error'>): PivotTab {
    if (ordinal === undefined) this.groups.delete(tabId)
    else this.groups.set(tabId, ordinal)
    const group = ordinal === undefined ? undefined : tab.groups.find(item => item.ordinal === ordinal)
    return {
      open: rest.open, source: group?.table.key, ...ordinal === undefined ? {} : { sourceName: `Result ${ordinal}` }, ...group?.pivot ? { pivot: group.pivot.key } : {},
      draft: this.draftOf(tabId, ordinal, group?.table.entry.descriptor.columns), running: rest.running, ...rest.error ? { error: rest.error } : {}
    }
  }

  /** A group's draft, fitted to its Table's columns: by name when they are not the ones it was last fitted to (a re-run). */
  private draftOf(tabId: string, ordinal: number | undefined, columns: readonly ResultColumn[] | undefined): PivotDraft {
    const drafts = ordinal === undefined ? undefined : this.drafts.get(tabId), kept = drafts?.get(ordinal!)
    if (!drafts || !kept) return emptyDraft
    if (!columns || kept.columns === columns) return kept.draft
    const draft = fitColumns(kept.columns ? remapDraft(kept.draft, kept.columns, columns) : kept.draft, columns)
    drafts.set(ordinal!, { draft, columns })
    return draft
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

  /** A new run (or a closed tab) gives up its tab's running pivot, and so does closing the Table it reads. The builder
   *  follows the focus: when another grid takes it, the builder moves to that grid's group, or to the first group that can
   *  be pivoted when the grid is a comparison or a plan set. It keeps its group by ordinal across runs, and moves to the
   *  first that can be pivoted once a run has ended without it. */
  private sync(): void {
    const snapshot = this.results.getSnapshot()
    for (const [tabId, item] of this.running) if (snapshot[tabId]?.queryId !== item.queryId || !snapshot[tabId].sets.some(entry => entry.key === item.source)) item.abort.abort()
    const current = this.getSnapshot()
    let tabs: Record<string, PivotTab> | undefined
    for (const [tabId, tab] of Object.entries(current.tabs)) {
      const run = snapshot[tabId]
      if (!run) {
        tabs ??= { ...current.tabs }
        delete tabs[tabId]
        this.runs.delete(tabId); this.groups.delete(tabId); this.drafts.delete(tabId); this.focus.delete(tabId)
        continue
      }
      let { running, error } = tab
      // A new run keeps each group's draft (a re-run of the same query pivots the same way) and the group the builder
      // belongs to; what the last run's build said goes.
      if (this.runs.get(tabId) !== run.queryId) { this.runs.set(tabId, run.queryId); running = false; error = undefined }
      let ordinal = this.groups.get(tabId)
      if (run.focused !== this.focus.get(tabId)) {
        this.focus.set(tabId, run.focused)
        if (run.focused !== undefined) ordinal = pivotGroup(run, run.focused)?.ordinal ?? run.groups.find(buildable)?.ordinal ?? ordinal
      }
      // Once the run has ended without that group (or it is a plan set), the builder moves to the first it can pivot.
      // While the run goes on, a result it has yet to return keeps the builder.
      ordinal = this.kept(run, ordinal) ?? (run.status === 'running' ? ordinal : run.groups.find(buildable)?.ordinal ?? ordinal)
      const next = this.tabOf(tabId, run, ordinal, { open: tab.open, running, error })
      if (next.source !== tab.source || next.sourceName !== tab.sourceName || next.pivot !== tab.pivot || next.draft !== tab.draft || next.running !== tab.running || next.error !== tab.error) {
        tabs ??= { ...current.tabs }
        tabs[tabId] = next
      }
    }
    // Strips of pivots no run shows any more go, whether or not a builder changed (Close Results changes none).
    const info = current.info.size ? this.shown(current.info) : current.info
    if (tabs || info.size !== current.info.size) this.publish({ tabs: tabs ?? current.tabs, info })
  }
}
