import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResolvedViewFilter, ResultColumn, ResultsPivotResult } from '../../../shared/contracts'
import { DerivedJobs } from './derived-jobs'
import { draftSpec, emptyDraft, fitDraft as fitColumns, remapDraft, type PivotDraft, type PivotInfo } from './pivot'
import { ResultError, type PivotSpec, type ResultView } from './ResultClient'
import type { EntryKey, PivotProvenance, ResultGroup, ResultSetEntry, ResultsService, TabResults } from './ResultsService'
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
  /** This group's Pivot is being built, or waits to be. */
  readonly running: boolean
  /** It waits for one of the window's places: four pivot builds and comparisons run at once. */
  readonly queued?: 'place' | 'busy'
  /** Why this group's last build failed. */
  readonly error?: string
}
export interface PivotSnapshot {
  readonly tabs: Readonly<Record<string, PivotTab>>
  /** Each pivot set's strip, by its set key. */
  readonly info: ReadonlyMap<string, PivotInfo>
}

type Results = Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'discard' | 'sortOf' | 'holdView'>
/** A build in flight: its run, the Table it reads, its group, the Pivot it replaces (none for a group's first), whether it
 *  still waits for a place, and whether the user cancelled it. */
interface Build {
  readonly abort: AbortController; readonly queryId: string; readonly source: EntryKey; readonly ordinal: number; readonly replaces?: EntryKey
  queued: 'place' | 'busy' | undefined; cancelled: boolean
}
/** What one build read and made: the pivot, the filters of the view it read (none for the stored rows), and whether it read
 *  a view. */
interface Built { readonly result: ResultsPivotResult; readonly filters: readonly ResolvedViewFilter[]; readonly viewed: boolean }
/** What the builder says when the user cancels a build while the group shows a Pivot, which stays. */
const cancelledText = (group: Pick<ResultGroup, 'ordinal' | 'pivot'>) => `Building was cancelled, so ${pivotName(group)} still shows its last build.`
/** "Pivot of Result 2": how the builder names a group's Pivot. */
const pivotName = (group: Pick<ResultGroup, 'ordinal' | 'pivot'>) => group.pivot ? entryName(group.pivot.entry) : `Pivot of Result ${group.ordinal}`

/** A set a pivot can read: a query's rows that have all loaded. Never a pivot, a comparison or a plan set. */
export const pivotable = (entry: ResultSetEntry | undefined): boolean =>
  entry !== undefined && entry.descriptor.kind === 'rows' && entry.handle.getSnapshot().state === 'complete'
/** A group a builder can belong to: one whose Table holds a query's rows (not a SQL-returned plan set). */
const buildable = (group: ResultGroup | undefined): group is ResultGroup => !!group && !group.planSet && group.table.entry.descriptor.kind === 'rows'
/**
 * The group Pivot acts on for the grid of entry `key`: the group whose Table or Pivot it shows. A comparison, a plan set,
 * and any grid of a bare run (Peek) have none, so Pivot is not offered there.
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
 * the Table, so building again replaces it atomically: the old one stays readable until the new one is built, which then
 * takes its slot and key; a build that fails or is cancelled leaves it as it was. The slot records what each build read
 * (its recipe, the Table's filters, its rows: ResultSlot.pivot), and opening the builder on the Pivot reopens its recipe.
 *
 * The builder belongs to one group: the one whose grid last had the focus, or the first that can be pivoted when that grid
 * is a comparison or a plan set. Each group keeps a draft of its own, which a new run's group of the same number takes
 * over, fitted to its columns by name. Builds of different groups run at once, at most four in a window (DerivedJobs,
 * which PR 16's comparisons are to share); a newer run (or none) gives up a build still running, as does closing its Table or the Pivot
 * it would replace.
 */
export class PivotService extends SnapshotStore<PivotSnapshot> implements Disposable {
  private readonly results: Results
  /** The builds in flight, by tab and ordinal: a newer run, its Table closed or the Pivot it replaces closed gives one up. */
  private readonly running = new Map<string, Map<number, Build>>()
  private readonly jobs: DerivedJobs
  /** Why each group's last build failed, by tab and ordinal: the builder shows it only while it is that group's, until
   *  that group's draft is edited or it is built again. */
  private readonly errors = new Map<string, Map<number, string>>()
  /** Strips of pivots added whose sets the results have not shown yet (they publish them on the next frame), with the
   *  tab and run they were added to: a publish for another tab in between must not drop them. */
  private readonly fresh = new Map<string, { readonly tabId: string; readonly queryId: string }>()
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

  constructor(results: Results, o: { jobs?: DerivedJobs } = {}) {
    super({ tabs: {}, info: new Map() })
    this.results = results
    this.jobs = o.jobs ?? new DerivedJobs()
    this.unsubscribe = results.subscribe(() => this.sync())
  }

  /** Opens the builder on the group of a grid (the one the command named or that has the focus): on the group whose Table
   *  or Pivot it shows, else on the group the builder had, else on the first that can be pivoted. On a Pivot, the group's
   *  draft becomes that Pivot's recipe: Edit Pivot starts from what it was built with. */
  open(tabId: string, key?: EntryKey): void {
    const tab = this.results.getSnapshot()[tabId]
    if (!tab || tab.bare) return
    const group = pivotGroup(tab, key)
    const ordinal = group?.ordinal ?? this.kept(tab, this.groups.get(tabId)) ?? tab.groups.find(buildable)?.ordinal
    const recipe = group?.pivot && group.pivot.key === key ? group.pivot.pivot?.recipe : undefined
    if (group && recipe) {
      let drafts = this.drafts.get(tabId)
      if (!drafts) this.drafts.set(tabId, drafts = new Map())
      const columns = group.table.entry.descriptor.columns
      drafts.set(group.ordinal, { draft: fitColumns({ rows: [...recipe.rows], ...recipe.column === undefined ? {} : { column: recipe.column }, values: recipe.values.map(value => ({ ...value })) } as PivotDraft, columns), columns })
    }
    this.runs.set(tabId, tab.queryId)
    this.focus.set(tabId, tab.focused)
    this.update(tabId, this.tabOf(tabId, tab, ordinal, true))
  }

  close(tabId: string): void {
    const current = this.getSnapshot().tabs[tabId]
    if (current?.open) this.update(tabId, { ...current, open: false })
  }

  setDraft(tabId: string, draft: PivotDraft): void {
    const current = this.getSnapshot().tabs[tabId], ordinal = this.groups.get(tabId), tab = this.results.getSnapshot()[tabId]
    if (!current || ordinal === undefined) return
    const columns = tab?.groups.find(group => group.ordinal === ordinal)?.table.entry.descriptor.columns
    // A group the run has yet to return has no columns to edit a draft over: the one it keeps waits for them.
    if (!tab || !columns) return
    let drafts = this.drafts.get(tabId)
    if (!drafts) this.drafts.set(tabId, drafts = new Map())
    drafts.set(ordinal, { draft: fitColumns(draft, columns), columns })
    // Editing the group's draft clears what its last build said.
    this.errors.get(tabId)?.delete(ordinal)
    this.update(tabId, this.tabOf(tabId, tab, ordinal, current.open))
  }

  /** Whether the group of a grid can be pivoted now: the grid shows the group's Table or Pivot, the run has ended, the
   *  Table's rows have all loaded, and its sort or filter is built (as Save Results As waits for it: the pivot reads the
   *  rows the Table's grid shows). Other groups' builds do not stand in the way. */
  canPivot(tabId: string, key: EntryKey | undefined): boolean {
    const tab = this.results.getSnapshot()[tabId], entry = pivotGroup(tab, key)?.table.entry
    const sort = entry && this.results.sortOf(tabId, entry.key)
    return !!tab && tab.status !== 'running' && tab.status !== 'closed' && pivotable(entry)
      && !(sort && (sort.sorting || sort.stale || !sort.view))
  }

  /**
   * Builds the builder's group's Pivot from its draft. The Pivot the group has stays readable meanwhile: the new result
   * takes its slot and key only once it is built (ResultsService.addSet), and then the old one is released. A failure, a
   * cancellation or a refusal keeps the old Pivot and says why in the builder. Builds of other groups go on beside it; a
   * newer build of the same group gives this one up. It waits for one of the window's places (DerivedJobs), which asks
   * again when the backend or the port is busy; it reads the Table's view as the grid shows it and keeps that view open
   * until it ends, and once more from the grid's current view when the backend had closed it.
   */
  async run(tabId: string): Promise<void> {
    const state = this.getSnapshot().tabs[tabId]
    const tab = this.results.getSnapshot()[tabId]
    const group = tab?.groups.find(item => item.ordinal === this.groups.get(tabId)), entry = group?.table.entry
    if (!state || !tab || !group || !entry || !this.canPivot(tabId, entry.key)) return
    let builds = this.running.get(tabId)
    if (!builds) this.running.set(tabId, builds = new Map())
    const replaces = group.pivot?.key
    // A run shows at most 1,000 results, derived ones included: a build that would pass it, counting the new Pivots being
    // built for other groups of this tab, is refused before the backend is asked, and leaves this group's build in flight
    // alone. A replacement takes no more room.
    const adding = [...builds.values()].filter(build => build.replaces === undefined && build.ordinal !== group.ordinal).length
    if (replaces === undefined && tab.sets.length + adding >= resultLimits.sets) {
      this.fail(tabId, group.ordinal, `These results already show ${resultLimits.sets.toLocaleString('en-US')} sets, so no pivot can be added. Close some results, or run the query again.`)
      this.refresh(tabId)
      return
    }
    // Per Pivot slot, a newer build gives up the older.
    builds.get(group.ordinal)?.abort.abort()
    builds.delete(group.ordinal)
    this.errors.get(tabId)?.delete(group.ordinal)
    const abort = new AbortController(), spec = draftSpec(state.draft)
    const item: Build = { abort, queryId: tab.queryId, source: entry.key, ordinal: group.ordinal, ...replaces === undefined ? {} : { replaces }, queued: undefined, cancelled: false }
    builds.set(group.ordinal, item)
    this.refresh(tabId)
    let error: string | undefined
    try {
      const built = await this.jobs.run<Built>(() => this.build(tabId, entry, spec, abort.signal), {
        signal: abort.signal, onWait: why => { item.queued = why; this.refresh(tabId) }, onStart: () => { item.queued = undefined; this.refresh(tabId) }
      })
      const { result, filters } = built
      // A build given up (a newer one, its Table or Pivot closed, a new run) adds nothing: its answer is released.
      if (abort.signal.aborted) {
        this.results.discard(result.descriptor)
        if (item.cancelled && replaces !== undefined) error = cancelledText(group)
        return
      }
      const sourceLabel = entryName(entry), snapshot = entry.handle.getSnapshot()
      const provenance: PivotProvenance = {
        recipe: spec, filters, inputRows: result.rows, truncated: snapshot.truncated !== undefined, incomplete: snapshot.incomplete, approximate: result.approximate
      }
      // Only the run that holds the Table takes the pivot; otherwise (a re-run, a closed tab) it is released, and the
      // builder says why when its run is still the one it pivoted.
      const added = this.results.addSet(tabId, result.descriptor, `Pivot of ${sourceLabel}`, [setKey(entry.descriptor)], { pivot: provenance })
      if (added === undefined) {
        const now = this.results.getSnapshot()[tabId]
        if (now?.queryId === tab.queryId) {
          error = now.sets.length >= resultLimits.sets
            ? `These results already show ${resultLimits.sets.toLocaleString('en-US')} sets, so the pivot was not added. Close some results, or run the query again.`
            : 'These results were closed, so the pivot was not added.'
        }
        return
      }
      const info: PivotInfo = {
        source: entry.key, sourceLabel, viewed: built.viewed, rows: result.rows, rowGroups: result.rowGroups,
        columnGroups: result.columnGroups, approximate: result.approximate, partial: provenance.truncated || provenance.incomplete
      }
      const current = this.getSnapshot()
      this.fresh.set(setKey(result.descriptor), { tabId, queryId: tab.queryId })
      this.publish({ tabs: current.tabs, info: new Map([...this.shown(current.info), [setKey(result.descriptor), info]]) })
    } catch (failure) {
      if (abort.signal.aborted) {
        // Cancelled by the user while a Pivot is shown: it stays, and the builder says so.
        if (item.cancelled && replaces !== undefined) error = cancelledText(group)
      } else {
        const message = failure instanceof Error ? failure.message : 'The results could not be pivoted.'
        // The old Pivot is never freed to make room: closing it first is the user's choice.
        error = replaces !== undefined && failure instanceof ResultError && failure.code === 'TOO_LARGE'
          ? `${message.replace(/\.\s*$/, '')}, or close ${pivotName(group)} and build it again.`
          : message
      }
    } finally {
      if (this.running.get(tabId)?.get(item.ordinal) === item) {
        this.running.get(tabId)!.delete(item.ordinal)
        if (error) this.fail(tabId, item.ordinal, error)
        this.refresh(tabId)
      }
    }
  }

  /** One build in the backend: the Table's view as its grid shows it now (held open until the build ends), or its stored
   *  rows. The backend may evict a view (it keeps eight a result): the build then runs once more, over the grid's current
   *  view when the grid has built another since, else over the same order and filters built again for it alone (closed
   *  when the build ends; the grid keeps its own view, which it will find closed when it next reads). */
  private async build(tabId: string, entry: ResultSetEntry, spec: PivotSpec, signal: AbortSignal): Promise<Built> {
    const shown = () => { const sort = this.results.sortOf(tabId, entry.key); return sort && !sort.sorting && !sort.stale ? sort.view : undefined }
    const view = shown()
    const once = async (source: ResultView | undefined): Promise<Built> => {
      const hold = source ? this.results.holdView(tabId, entry.key, source) : undefined
      try { return { result: await (source ?? entry.handle).pivot(spec, { signal }), filters: source?.filters ?? [], viewed: !!source } }
      finally { hold?.() }
    }
    try {
      return await once(view)
    } catch (error) {
      if (!view || signal.aborted || !(error instanceof ResultError) || error.code !== 'VIEW_NOT_FOUND') throw error
    }
    const current = shown()
    if (current && current !== view) return once(current)
    const rebuilt = await entry.handle.sort(view.keys, { ...view.filters.length ? { filters: view.filters } : {}, signal })
    try {
      const built = await (rebuilt.pivot(spec, { signal }))
      return { result: built, filters: rebuilt.filters, viewed: true }
    } finally {
      void rebuilt.close().catch(() => {})
    }
  }

  /** Stops the builder's group's build. A Pivot the group has stays as it was. */
  cancel(tabId: string): void {
    const ordinal = this.groups.get(tabId), build = ordinal === undefined ? undefined : this.running.get(tabId)?.get(ordinal)
    if (!build) return
    build.cancelled = true
    build.abort.abort()
  }

  dispose(): void {
    this.unsubscribe()
    for (const builds of this.running.values()) for (const build of builds.values()) build.abort.abort()
    this.running.clear()
    this.clearListeners()
  }

  private fail(tabId: string, ordinal: number, error: string): void {
    let errors = this.errors.get(tabId)
    if (!errors) this.errors.set(tabId, errors = new Map())
    errors.set(ordinal, error)
  }

  /** The ordinal, while the run has a group of it that can be pivoted, or may yet return one. */
  private kept(tab: TabResults, ordinal: number | undefined): number | undefined {
    if (ordinal === undefined) return undefined
    const group = tab.groups.find(item => item.ordinal === ordinal)
    return buildable(group) || (!group && tab.status === 'running') ? ordinal : undefined
  }

  /** The builder's state on the group `ordinal` of a run, which it belongs to from now on. A build and its failure are
   *  one group's: the builder says "running" and shows the failure only while it is that group's. */
  private tabOf(tabId: string, tab: TabResults, ordinal: number | undefined, open: boolean): PivotTab {
    if (ordinal === undefined) this.groups.delete(tabId)
    else this.groups.set(tabId, ordinal)
    const group = ordinal === undefined ? undefined : tab.groups.find(item => item.ordinal === ordinal)
    const building = ordinal === undefined ? undefined : this.running.get(tabId)?.get(ordinal), failed = ordinal === undefined ? undefined : this.errors.get(tabId)?.get(ordinal)
    const live = building?.queryId === tab.queryId ? building : undefined
    return {
      open, source: group?.table.key, ...ordinal === undefined ? {} : { sourceName: `Result ${ordinal}` }, ...group?.pivot ? { pivot: group.pivot.key } : {},
      draft: this.draftOf(tabId, ordinal, group?.table.entry.descriptor.columns), running: !!live,
      ...live?.queued ? { queued: live.queued } : {}, ...failed ? { error: failed } : {}
    }
  }

  /** Publishes the builder's state again, on the group it has (after a build started or ended). */
  private refresh(tabId: string): void {
    const current = this.getSnapshot().tabs[tabId], tab = this.results.getSnapshot()[tabId]
    if (current && tab) this.update(tabId, this.tabOf(tabId, tab, this.groups.get(tabId), current.open))
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

  /** Only pivots some run still shows keep their strips, and those just added that their run has yet to publish. */
  private shown(info: ReadonlyMap<string, PivotInfo>): Map<string, PivotInfo> {
    const snapshot = this.results.getSnapshot()
    const shown = new Set(Object.values(snapshot).flatMap(run => run.sets.map(entry => setKey(entry.descriptor))))
    for (const [key, added] of this.fresh) {
      const run = snapshot[added.tabId]
      if (shown.has(key) || run?.queryId !== added.queryId || run.status === 'closed') this.fresh.delete(key)
    }
    return new Map([...info].filter(([key]) => shown.has(key) || this.fresh.has(key)))
  }

  /** A new run (or a closed tab) gives up its tab's running pivot, and so does closing the Table it reads. The builder
   *  follows the focus: when another grid takes it, the builder moves to that grid's group, or to the first group that can
   *  be pivoted when the grid is a comparison or a plan set. It keeps its group by ordinal across runs, and moves to the
   *  first that can be pivoted once a run has ended without it. */
  private sync(): void {
    const snapshot = this.results.getSnapshot()
    for (const [tabId, builds] of this.running) {
      const run = snapshot[tabId]
      for (const build of builds.values()) {
        // The Pivot a build would replace was closed: it would come back as a slot the user closed, so it is given up.
        const group = run?.queryId === build.queryId ? run.groups.find(item => item.table.key === build.source) : undefined
        if (!group || (build.replaces !== undefined && group.pivot?.key !== build.replaces)) build.abort.abort()
      }
    }
    const current = this.getSnapshot()
    let tabs: Record<string, PivotTab> | undefined
    for (const [tabId, tab] of Object.entries(current.tabs)) {
      const run = snapshot[tabId]
      if (!run) {
        tabs ??= { ...current.tabs }
        delete tabs[tabId]
        this.runs.delete(tabId); this.groups.delete(tabId); this.drafts.delete(tabId); this.focus.delete(tabId); this.errors.delete(tabId)
        continue
      }
      // A new run keeps each group's draft (a re-run of the same query pivots the same way) and the group the builder
      // belongs to; what the last run's build said goes.
      if (this.runs.get(tabId) !== run.queryId) { this.runs.set(tabId, run.queryId); this.errors.delete(tabId) }
      let ordinal = this.groups.get(tabId)
      if (run.focused !== this.focus.get(tabId)) {
        this.focus.set(tabId, run.focused)
        // The focused grid's group, whichever of its views it is; a comparison or a plan set
        // has none to pivot, so the first that can be.
        const group = groupOf(run, run.focused)
        if (run.focused !== undefined) ordinal = (buildable(group) ? group.ordinal : undefined) ?? run.groups.find(buildable)?.ordinal ?? ordinal
      }
      // Once the run has ended without that group (or it is a plan set), the builder moves to the first it can pivot.
      // While the run goes on, a result it has yet to return keeps the builder.
      ordinal = this.kept(run, ordinal) ?? (run.status === 'running' ? ordinal : run.groups.find(buildable)?.ordinal ?? ordinal)
      const next = this.tabOf(tabId, run, ordinal, tab.open)
      if (next.source !== tab.source || next.sourceName !== tab.sourceName || next.pivot !== tab.pivot || next.draft !== tab.draft || next.running !== tab.running || next.queued !== tab.queued || next.error !== tab.error) {
        tabs ??= { ...current.tabs }
        tabs[tabId] = next
      }
    }
    // Strips of pivots no run shows any more go, whether or not a builder changed (Close Results changes none).
    const info = current.info.size ? this.shown(current.info) : current.info
    if (tabs || info.size !== current.info.size) this.publish({ tabs: tabs ?? current.tabs, info })
  }
}
