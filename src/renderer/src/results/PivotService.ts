import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResolvedViewFilter, ResultColumn, ResultsPivotResult } from '../../../shared/contracts'
import { DerivedJobs } from './derived-jobs'
import { draftSpec, emptyDraft, fitDraft as fitColumns, remapDraft, type PivotDraft, type PivotInfo } from './pivot'
import { ResultError, type OperationProgressListener, type PivotSpec, type ResultView } from './ResultClient'
import type { EntryKey, PivotProvenance, ResultGroup, ResultSetEntry, ResultsService, TabResults } from './ResultsService'
import { entryName, filtersIdentity, groupOf, pivotOutOfDate, resultLimits, selectedEntry, setKey, shownFilters, slotOf } from './ResultsService'

/**
 * When a Pivot rebuilds by itself after its Table's filters change (the owner's figures, 2026-11-12): the Table's result
 * stores at most `maxSourceRows` rows (a build keys every stored row, whatever the filters keep) and the Pivot's last build
 * took under `maxLastBuildMs`, both required. The time is what covers machines with few cores, long decimals and Distinct
 * Count, which the row count cannot see. Otherwise the Pivot stays marked out of date and offers Update.
 */
export const pivotFollow = { maxSourceRows: 500_000, maxLastBuildMs: 250 } as const

export type ResultsLayout = 'stacked' | 'tabs'
/**
 * Whether a group's Pivot is shown, so it may rebuild by itself: the Results panel is showing (`resultsShowing`, the dock's
 * own report, not the output view last picked: Messages docked beside Results or popped out leaves Results showing, and a
 * closed or hidden Results panel shows nothing), and in Tabs its view is the one selected, in Stacked its item is expanded
 * (a collapsed item is its caption alone, and its grid is not drawn). Scrolling the stack does not count: an expanded Pivot
 * is drawn in it wherever it stands.
 */
export function pivotShown(tab: Pick<TabResults, 'sets' | 'focused' | 'bare'>, group: Pick<ResultGroup, 'pivot'>, layout: ResultsLayout, collapsed: ReadonlySet<EntryKey>, resultsShowing: boolean): boolean {
  const key = group.pivot?.key
  if (key === undefined || tab.bare || !resultsShowing) return false
  return layout === 'tabs' ? selectedEntry(tab)?.key === key : !collapsed.has(key)
}
/** Whether a Pivot's own size and history let it rebuild by itself (`pivotFollow`): its Table's stored rows and its last
 *  build's time. A Pivot whose build time is unknown never does. */
export function followsByItself(group: Pick<ResultGroup, 'table' | 'pivot'>): boolean {
  const built = group.pivot?.pivot
  return !!built && built.buildMs !== undefined && built.buildMs < pivotFollow.maxLastBuildMs
    && group.table.entry.handle.getSnapshot().rowsStored <= pivotFollow.maxSourceRows
}

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
  /** Changes whenever a build starts or ends, listing the groups with a build in flight by tab and ordinal. A build a new
   *  run gave up stays listed until it settles, so read `building(tabId, ordinal)` (which checks the run), as captions do. */
  readonly building: Readonly<Record<string, readonly number[]>>
}

type Results = Pick<ResultsService, 'getSnapshot' | 'subscribe' | 'addSet' | 'discard' | 'sortOf' | 'holdView' | 'notify' | 'copyingEntry' | 'operations'> & Partial<Pick<ResultsService, 'viewState'>>
/** How the window lays results out (queryResults.grid.layout) and whether the Results panel shows, for whether a Pivot is shown. Without one no Pivot follows its
 *  Table's filters by itself (the checks that do not ask for it). */
export interface PivotFollowHost {
  layout(): ResultsLayout
  /** Whether the Results panel is showing (docked and selected in its group, floating or popped out). */
  resultsShowing(): boolean
  /** Called when either changes. */
  onLayout(listener: () => void): () => void
}
/** A build in flight: its run, the Table it reads, its group, the Pivot it replaces (none for a group's first), whether it
 *  still waits for a place, and whether the user cancelled it. */
interface Build {
  readonly abort: AbortController; readonly queryId: string; readonly source: EntryKey; readonly ordinal: number; readonly replaces?: EntryKey
  /** Update started it (the Pivot's own recipe, not the builder's draft): what it says goes to the toolbar too, since the
   *  builder may be closed or on another group. */
  readonly update: boolean
  /** It rebuilds by itself, for the Table's filters of this identity (`filtersIdentity`): a newer change gives it up. */
  readonly auto?: string
  queued: 'place' | 'busy' | undefined; cancelled: boolean
  /** When it last took its place: the build's time is measured from there to its answer, leaving out its waits. */
  startedAt?: number
}
/** What one build read and made: the pivot, the filters of the view it read (none for the stored rows), and whether it read
 *  a view. */
interface Built { readonly result: ResultsPivotResult; readonly filters: readonly ResolvedViewFilter[]; readonly viewed: boolean }
/** A Pivot's stored recipe as a request's spec, copied so the request never shares the provenance's arrays. */
const recipeSpec = (recipe: PivotProvenance['recipe']): PivotSpec =>
  ({ rows: [...recipe.rows], ...recipe.column === undefined ? {} : { column: recipe.column }, values: recipe.values.map(value => ({ ...value })) }) as PivotSpec
/** What the builder says when the user cancels a build while the group shows a Pivot, which stays. */
const cancelledText = (group: Pick<ResultGroup, 'table' | 'pivot'>) => `Building was cancelled, so ${pivotName(group)} still shows its last build.`
/** "Pivot of Result 2", "Pivot of Open orders": how the builder names a group's Pivot. */
const pivotName = (group: Pick<ResultGroup, 'table' | 'pivot'>) => group.pivot ? entryName(group.pivot.entry) : `Pivot of ${entryName(group.table.entry)}`

/** A set a pivot can read: a query's rows that have all loaded. Never a pivot, a comparison or a plan set. */
export const pivotable = (entry: ResultSetEntry | undefined): boolean =>
  entry !== undefined && entry.descriptor.kind === 'rows' && entry.handle.getSnapshot().state === 'complete'
/** A group a builder can belong to: one whose Table holds a query's rows (not a SQL-returned plan set). */
const buildable = (group: ResultGroup | undefined): group is ResultGroup => !!group && !group.planSet && group.table.entry.descriptor.kind === 'rows'
/** A tab's results are gone, with nothing to show the builder beside: Close Results, or a finished run with no result left
 *  (none returned, or the last one closed). The Compare popover closes by the same rule. A running run is not gone: a re-run
 *  releases the old results before its first set arrives. */
const resultsGone = (tab: TabResults): boolean => tab.status === 'closed' || (tab.status !== 'running' && tab.sets.length === 0)
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
 * shared with comparisons); a newer run (or none) gives up a build still running, as does closing its Table or the Pivot
 * it would replace.
 */
export class PivotService extends SnapshotStore<PivotSnapshot> implements Disposable {
  private readonly results: Results
  /** The builds in flight, by tab and ordinal: a newer run, its Table closed or the Pivot it replaces closed gives one up. */
  private readonly running = new Map<string, Map<number, Build>>()
  private readonly jobs: DerivedJobs
  /** New results other services are building for a tab's current run (comparisons), counted against its 1,000. */
  private readonly elsewhere: (tabId: string) => number
  /** Why each group's last build failed, by tab and ordinal: the builder shows it only while it is that group's, until
   *  that group's draft is edited or it is built again. `draft`: a Build Pivot of the builder's draft failed, which a
   *  Pivot following its Table's filters (another recipe, its own) does not answer, so an automatic build keeps it. */
  private readonly errors = new Map<string, Map<number, { readonly text: string; readonly draft: boolean }>>()
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
  private readonly follow: PivotFollowHost | undefined
  private readonly now: () => number
  private readonly defer: (callback: () => void) => void
  /** The Table's filters each group was last built over (`filtersIdentity`), by tab and ordinal, with the run: a Pivot
   *  does not rebuild by itself over the filters it was last built over (only the last set is kept), so a build that
   *  failed, was refused or cancelled is not asked again until the filters change or the user asks (Update). */
  private readonly tried = new Map<string, Map<number, { readonly queryId: string; readonly filters: string }>>()
  private following = false
  private disposed = false

  constructor(results: Results, o: { jobs?: DerivedJobs; adding?: (tabId: string) => number; follow?: PivotFollowHost; now?: () => number; defer?: (callback: () => void) => void } = {}) {
    super({ tabs: {}, info: new Map(), building: {} })
    this.results = results
    this.jobs = o.jobs ?? new DerivedJobs()
    this.elsewhere = o.adding ?? (() => 0)
    this.follow = o.follow
    this.now = o.now ?? (() => performance.now())
    // Called unbound: Chromium's queueMicrotask throws Illegal invocation when called as a method of another object.
    this.defer = o.defer ?? (callback => queueMicrotask(callback))
    const unsubscribe = results.subscribe(() => this.sync())
    const layout = o.follow?.onLayout(() => this.followLater())
    this.unsubscribe = () => { unsubscribe(); layout?.() }
  }

  /** The first Pivots being built for a tab's current run: results it will add, which comparisons count against its 1,000. */
  adding(tabId: string): number {
    const queryId = this.results.getSnapshot()[tabId]?.queryId
    return [...this.running.get(tabId)?.values() ?? []].filter(build => build.replaces === undefined && build.queryId === queryId).length
  }

  /** Opens the builder on the group of a grid (the one the command named or that has the focus): on the group whose Table
   *  or Pivot it shows, else on the group the builder had, else on the first that can be pivoted. On a Pivot, the group's
   *  draft becomes that Pivot's recipe: Edit Pivot starts from what it was built with. */
  open(tabId: string, key?: EntryKey): void {
    const tab = this.results.getSnapshot()[tabId]
    if (!tab || tab.bare || resultsGone(tab)) return
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
    this.setTab(tabId, this.tabOf(tabId, tab, ordinal, true))
  }

  close(tabId: string): void {
    const current = this.getSnapshot().tabs[tabId]
    if (current?.open) this.setTab(tabId, { ...current, open: false })
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
    this.setTab(tabId, this.tabOf(tabId, tab, ordinal, current.open))
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
   * again when the backend or the port is busy; it reads the Table's view as the grid showed it at the click (held open
   * from then until it ends, so a sort or filter begun while it waits changes nothing it reads), and once more from the
   * grid's current view when the backend had closed it.
   */
  async run(tabId: string): Promise<void> {
    const state = this.getSnapshot().tabs[tabId]
    const tab = this.results.getSnapshot()[tabId]
    const group = tab?.groups.find(item => item.ordinal === this.groups.get(tabId))
    if (!state || !tab || !group || !this.canPivot(tabId, group.table.key)) return
    return this.start(tabId, tab, group, draftSpec(state.draft), false)
  }

  /**
   * Update: builds a group's Pivot again from its own recipe (what it was last built with, not the builder's draft, which
   * stays as it is) over the Table as its grid shows it now, through Build Pivot's path: the old Pivot stays readable until
   * the new one publishes in its slot, the build takes one of the window's places, and a failure, a cancellation or a
   * refusal keeps the old Pivot and says why in the toolbar (and in the builder while it is on that group). `key` is the
   * Pivot's grid or its Table's. It does nothing while the group has no Pivot, cannot be pivoted now, or its Pivot is being
   * built.
   */
  async update(tabId: string, key: EntryKey | undefined): Promise<void> {
    const tab = this.results.getSnapshot()[tabId], group = pivotGroup(tab, key)
    const recipe = group?.pivot?.pivot?.recipe
    if (!tab || !group || !recipe || this.building(tabId, group.ordinal) || !this.canPivot(tabId, group.table.key)) return
    return this.start(tabId, tab, group, recipeSpec(recipe), true)
  }

  /** Whether a group's Pivot is being built, or waits to be, for the tab's current run. */
  building(tabId: string, ordinal: number): boolean {
    const build = this.running.get(tabId)?.get(ordinal)
    return !!build && build.queryId === this.results.getSnapshot()[tabId]?.queryId
  }

  /** One build of a group's Pivot from `spec`: Build Pivot's (the draft) or Update's (`update`, the Pivot's recipe), which
   *  is also what a Pivot following its Table's filters runs (`auto`). */
  private async start(tabId: string, tab: TabResults, group: ResultGroup, spec: PivotSpec, update: boolean, auto = false): Promise<void> {
    const entry = group.table.entry
    let builds = this.running.get(tabId)
    if (!builds) this.running.set(tabId, builds = new Map())
    const replaces = group.pivot?.key
    // A run shows at most 1,000 results, derived ones included: a build that would pass it, counting the new Pivots being
    // built for other groups of this tab and the comparisons in flight, is refused before the backend is asked, and leaves
    // this group's build in flight alone. A replacement takes no more room.
    const adding = [...builds.values()].filter(build => build.replaces === undefined && build.ordinal !== group.ordinal && build.queryId === tab.queryId).length + this.elsewhere(tabId)
    if (replaces === undefined && tab.sets.length + adding >= resultLimits.sets) {
      this.fail(tabId, group.ordinal, `These results already show ${resultLimits.sets.toLocaleString('en-US')} sets, so no pivot can be added. Close some results, or run the query again.`)
      this.refresh(tabId)
      return
    }
    // Per Pivot slot, a newer build gives up the older.
    builds.get(group.ordinal)?.abort.abort()
    builds.delete(group.ordinal)
    // A user's build starts afresh; an automatic one leaves what the last build said (a Build Pivot of another recipe
    // that failed while the filters changed), so following the filters never hides why the user's build failed.
    if (!auto || !this.errors.get(tabId)?.get(group.ordinal)?.draft) this.errors.get(tabId)?.delete(group.ordinal)
    const abort = new AbortController()
    // The rows as the grid shows them now: canPivot refused while a sort or filter was being built.
    const shown = this.results.sortOf(tabId, entry.key)?.view
    const hold = shown ? this.results.holdView(tabId, entry.key, shown) : undefined
    // These filters have now been built over, whatever the build's end: the Pivot does not rebuild by itself for them again.
    let tried = this.tried.get(tabId)
    if (!tried) this.tried.set(tabId, tried = new Map())
    const reads = filtersIdentity(shown?.filters ?? [])
    tried.set(group.ordinal, { queryId: tab.queryId, filters: reads })
    const item: Build = {
      // An automatic build is named by the filters of the view it reads (the results' own state, which may be a frame
      // ahead of the snapshot that started it), so it is superseded only by filters it does not read.
      abort, queryId: tab.queryId, source: entry.key, ordinal: group.ordinal, ...replaces === undefined ? {} : { replaces }, update, ...auto ? { auto: reads } : {},
      queued: undefined, cancelled: false
    }
    builds.set(group.ordinal, item)
    this.refresh(tabId)
    this.publishBuilding()
    // The toolbar's strip and the Table grid's bar show the build; their Cancel is the caption's.
    const ticket = this.results.operations.begin(tabId, { kind: 'pivot', target: entryName(entry), entry: entry.key, cancel: () => this.cancel(tabId, group.ordinal) })
    let error: string | undefined, done = false
    try {
      const built = await this.jobs.run<Built>(() => this.build(tabId, entry, spec, shown, abort.signal, (phase, percent) => ticket.progress(phase, percent)), {
        signal: abort.signal, onWait: why => { item.queued = why; this.refresh(tabId) }, onStart: () => { item.queued = undefined; item.startedAt = this.now(); this.refresh(tabId) }
      })
      const buildMs = Math.max(0, this.now() - (item.startedAt ?? this.now()))
      const { result, filters } = built
      // A build given up (a newer one, its Table or Pivot closed, a new run) adds nothing: its answer is released.
      if (abort.signal.aborted) {
        this.results.discard(result.descriptor)
        if (item.cancelled && replaces !== undefined) error = cancelledText(group)
        return
      }
      // A copy of the Pivot started after this build's last look (before the follow could give it up): the answer is
      // released rather than cancel the copy, and its filters are built again once the copy ends.
      if (auto && replaces !== undefined && this.results.copyingEntry(tabId) === replaces) {
        this.results.discard(result.descriptor)
        const last = this.tried.get(tabId)
        if (last?.get(item.ordinal)?.filters === reads) last.delete(item.ordinal)
        return
      }
      const sourceLabel = entryName(entry), snapshot = entry.handle.getSnapshot()
      const provenance: PivotProvenance = {
        recipe: spec, filters, inputRows: result.rows, truncated: snapshot.truncated !== undefined, incomplete: snapshot.incomplete, approximate: result.approximate, buildMs,
        ...auto ? { followed: true as const } : {}
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
      done = true
      const info: PivotInfo = {
        source: entry.key, sourceLabel, viewed: built.viewed, rows: result.rows, rowGroups: result.rowGroups,
        columnGroups: result.columnGroups, approximate: result.approximate, partial: provenance.truncated || provenance.incomplete
      }
      const current = this.getSnapshot()
      this.fresh.set(setKey(result.descriptor), { tabId, queryId: tab.queryId })
      this.publish({ ...current, info: new Map([...this.shown(current.info), [setKey(result.descriptor), info]]) })
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
      hold?.()
      // A cancel the builder or toolbar already words (a Pivot kept) is said once, by them.
      ticket.end(done ? 'done' : item.cancelled && error === undefined ? 'cancelled' : 'dropped')
      if (this.running.get(tabId)?.get(item.ordinal) === item) {
        this.running.get(tabId)!.delete(item.ordinal)
        // A failed Build Pivot's reason stays in the builder until the user acts: an automatic build's failure goes only to
        // the toolbar. A cancel is not the draft's failure, so a later build over the Pivot's recipe clears what it said.
        const keeps = item.auto !== undefined && !!this.errors.get(tabId)?.get(item.ordinal)?.draft
        if (error && !keeps) this.fail(tabId, item.ordinal, error, !item.update && !item.cancelled)
        // Update's caller, or a caption's Cancel, may not be looking at the builder: the toolbar says it too, while the run is still the one it
        // updated (a new run or a closed tab has nothing to say it about).
        if (error && (item.update || item.cancelled) && this.results.getSnapshot()[tabId]?.queryId === item.queryId) this.results.notify(tabId, error)
        this.refresh(tabId)
        this.publishBuilding()
        // A build that ends without publishing (a failure, a refusal) publishes no results: the Pivot is looked at again
        // here, so filters changed while it ran are followed now, not at the next unrelated publish.
        this.followLater()
      }
    }
  }

  /** One build in the backend: the Table's view the grid showed at the click (`view`, held by run), or its stored rows. The backend may evict a view (it keeps eight a result): the build then runs once more, over the grid's current
   *  view when the grid has built another since, else over the same order and filters built again for it alone (closed
   *  when the build ends; the grid keeps its own view, which it will find closed when it next reads). */
  private async build(tabId: string, entry: ResultSetEntry, spec: PivotSpec, view: ResultView | undefined, signal: AbortSignal, onProgress: OperationProgressListener): Promise<Built> {
    const shown = () => { const sort = this.results.sortOf(tabId, entry.key); return sort && !sort.sorting && !sort.stale ? sort.view : undefined }
    const once = async (source: ResultView | undefined): Promise<Built> => {
      const hold = source ? this.results.holdView(tabId, entry.key, source) : undefined
      try { return { result: await (source ?? entry.handle).pivot(spec, { signal, onProgress }), filters: source?.filters ?? [], viewed: !!source } }
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
      const built = await (rebuilt.pivot(spec, { signal, onProgress }))
      return { result: built, filters: rebuilt.filters, viewed: true }
    } finally {
      void rebuilt.close().catch(() => {})
    }
  }

  /** Stops a group's build: the builder's group's, or the one `ordinal` names (a caption's Cancel). A Pivot the group has
   *  stays as it was. */
  cancel(tabId: string, ordinal = this.groups.get(tabId)): void {
    const build = ordinal === undefined ? undefined : this.running.get(tabId)?.get(ordinal)
    if (!build) return
    build.cancelled = true
    // The user stopped it: the filters the Table's grid shows now (its own state, which may be a frame ahead of the
    // published run) count as tried, so the cancel is not undone at once by an automatic build over filters changed while
    // it ran (Update still asks for one).
    const tab = this.results.getSnapshot()[tabId]
    if (tab?.queryId === build.queryId) this.tried.get(tabId)?.set(build.ordinal, { queryId: build.queryId, filters: filtersIdentity(this.results.sortOf(tabId, build.source)?.view?.filters ?? []) })
    build.abort.abort()
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    for (const builds of this.running.values()) for (const build of builds.values()) build.abort.abort()
    this.running.clear()
    this.clearListeners()
  }

  /** Publishes which groups' Pivots are being built, when that changed. */
  private publishBuilding(): void {
    const current = this.getSnapshot(), building: Record<string, readonly number[]> = {}
    for (const [tabId, builds] of this.running) if (builds.size) building[tabId] = [...builds.keys()].sort((a, b) => a - b)
    const same = Object.keys(building).length === Object.keys(current.building).length
      && Object.entries(building).every(([tabId, list]) => current.building[tabId]?.join(',') === list.join(','))
    if (!same) this.publish({ ...current, building })
  }

  private fail(tabId: string, ordinal: number, error: string, draft = true): void {
    let errors = this.errors.get(tabId)
    if (!errors) this.errors.set(tabId, errors = new Map())
    errors.set(ordinal, { text: error, draft })
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
    const building = ordinal === undefined ? undefined : this.running.get(tabId)?.get(ordinal), failed = ordinal === undefined ? undefined : this.errors.get(tabId)?.get(ordinal)?.text
    const live = building?.queryId === tab.queryId ? building : undefined
    return {
      open, source: group?.table.key, ...ordinal === undefined ? {} : { sourceName: group ? entryName(group.table.entry) : `Result ${ordinal}` }, ...group?.pivot ? { pivot: group.pivot.key } : {},
      draft: this.draftOf(tabId, ordinal, group?.table.entry.descriptor.columns), running: !!live,
      ...live?.queued ? { queued: live.queued } : {}, ...failed ? { error: failed } : {}
    }
  }

  /** Publishes the builder's state again, on the group it has (after a build started or ended). */
  private refresh(tabId: string): void {
    const current = this.getSnapshot().tabs[tabId], tab = this.results.getSnapshot()[tabId]
    if (current && tab) this.setTab(tabId, this.tabOf(tabId, tab, this.groups.get(tabId), current.open))
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

  private setTab(tabId: string, tab: PivotTab): void {
    const snapshot = this.getSnapshot()
    this.publish({ ...snapshot, tabs: { ...snapshot.tabs, [tabId]: tab } })
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
   *  first that can be pivoted once a run has ended without it. Once the tab's results are gone (`resultsGone`) the builder
   *  closes, as the Compare popover does; its drafts stay for the group's next Pivot… */
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
      const next = this.tabOf(tabId, run, ordinal, tab.open && !resultsGone(run))
      if (next.open !== tab.open || next.source !== tab.source || next.sourceName !== tab.sourceName || next.pivot !== tab.pivot || next.draft !== tab.draft || next.running !== tab.running || next.queued !== tab.queued || next.error !== tab.error) {
        tabs ??= { ...current.tabs }
        tabs[tabId] = next
      }
    }
    // Strips of pivots no run shows any more go, whether or not a builder changed.
    const info = current.info.size ? this.shown(current.info) : current.info
    if (tabs || info.size !== current.info.size) this.publish({ ...current, tabs: tabs ?? current.tabs, info })
    this.followLater()
  }

  /** Looks at the Pivots following their Tables after the current task (a microtask, never a timer): one look for a
   *  publish and whatever else changed with it, outside the results' own listeners. */
  private followLater(): void {
    if (!this.follow || this.following || this.disposed) return
    this.following = true
    this.defer(() => { this.following = false; if (!this.disposed) this.followAll() })
  }

  /** Every group's Pivot that follows its Table's filters: see `followGroup`. */
  private followAll(): void {
    const layout = this.follow!.layout(), showing = this.follow!.resultsShowing(), snapshot = this.results.getSnapshot()
    for (const [tabId, tried] of this.tried) {
      const tab = snapshot[tabId]
      if (!tab) { this.tried.delete(tabId); continue }
      for (const [ordinal, last] of tried) if (last.queryId !== tab.queryId) tried.delete(ordinal)
    }
    for (const [tabId, tab] of Object.entries(snapshot)) {
      if (tab.bare || !tab.groups.some(group => group.pivot)) continue
      const collapsed = this.results.viewState?.(tabId).collapsed ?? new Set<EntryKey>()
      for (const group of tab.groups) this.followGroup(tabId, tab, group, layout, collapsed, showing)
    }
  }

  /**
   * A Pivot follows its Table's filters (PR 17): once the filters the Table's grid shows differ from those it was built
   * over, it rebuilds by itself from its own recipe through Update's path, when it is shown (`pivotShown`), its Table can
   * be pivoted now, and it is small and quick enough (`followsByItself`); otherwise it stays marked out of date with
   * Update, and rebuilds when it is shown. It does not rebuild by itself over the filters it last built over (`tried`). An automatic build whose
   * filters are no longer the Table's (a newer change, or the change undone), or whose Pivot is hidden, is given up silently: its answer would be out
   * of date when it landed, and its filters may be tried again. A build the user started (Build Pivot, Update) is never
   * given up or overtaken here; once it ends the Pivot is looked at again. A user's cancel counts the filters shown then as
   * tried.
   */
  private followGroup(tabId: string, tab: TabResults, group: ResultGroup, layout: ResultsLayout, collapsed: ReadonlySet<EntryKey>, showing: boolean): void {
    const recipe = group.pivot?.pivot?.recipe
    if (!recipe) return
    // A build already given up (superseded, cancelled) is no longer in flight here, though it stays listed until it settles.
    const build = this.running.get(tabId)?.get(group.ordinal), live = build?.queryId === tab.queryId && !build.abort.signal.aborted ? build : undefined
    // The grid's filters may have shown a newer view not yet published (results publish on the next frame): its publish
    // looks again, so nothing is decided over filters about to change.
    const published = tab.sorts.get(group.table.key)?.view
    if (published !== this.results.sortOf(tabId, group.table.key)?.view) return
    const filters = filtersIdentity(shownFilters(tab, group.table.key))
    // Hidden while it builds (Messages picked, another view selected, its item collapsed), it is given up too: only a shown
    // Pivot rebuilds by itself, and it rebuilds when shown again.
    // A copy of the Pivot the user started is never stopped by a rebuild nobody asked for (`replaceSet` cancels it): the
    // Pivot waits until it ends, whose publish looks again. The service's own state is read: a copy started this frame is
    // not yet in the published job list.
    const copying = this.results.copyingEntry(tabId) === group.pivot!.key
    const superseded = live?.auto !== undefined && (live.auto !== filters || copying || !pivotShown(tab, group, layout, collapsed, showing))
    if (superseded) {
      // Given up by this service, not ended: its filters were never built over, so they may be tried again (the change
      // undone, then made again).
      const tried = this.tried.get(tabId)
      if (tried?.get(group.ordinal)?.filters === live!.auto) tried!.delete(group.ordinal)
      live!.abort.abort()
    }
    if ((live && !superseded) || copying || !pivotOutOfDate(tab, group)) return
    const tried = this.tried.get(tabId)?.get(group.ordinal)
    if (tried?.queryId === tab.queryId && tried.filters === filters) return
    if (!pivotShown(tab, group, layout, collapsed, showing) || !followsByItself(group) || !this.canPivot(tabId, group.table.key)) return
    void this.start(tabId, tab, group, recipeSpec(recipe), true, true)
  }
}
