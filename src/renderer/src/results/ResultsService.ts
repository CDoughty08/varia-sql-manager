import { limits as wire, type ErrorCode } from '../../../shared/ipc/wire/protocol'
import { cycleSortKeys, sortKeysBy, type SortDirection } from '../grid/sort-keys'
import type { MessageEntry, QueryEvent, QueryResult, QueryStatus, ResolvedGroupsFilter, ResolvedViewFilter, ResultColumn, ResultDescriptor, ResultsJobProgress, VariaApi, ViewFilter, ViewSortKey, ViewSortMode } from '../../../shared/contracts'
import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { requestFrame } from '../core/windows'
import { gridLimits as g } from '../grid/constants'
import { copyPlan, noColumnName, resolveBlocks, selectAll, type GridSelection } from '../grid/selection'
import { kindInfo } from '../documents'
import type { DocumentService, TextDocument } from '../services/documents'
import type { DistinctList, ResultClient, ResultHandle, ResultView } from './ResultClient'
import type { ResultKey } from './worker-protocol'
import { completionSentence, formatCount, plural } from './status'
import { columnFilterKind, conditionFilter, conditionKind, sameFilterFamily, type ColumnCondition } from './column-filter'
import { retainedPlanLimits, type PlanExecutionContext, type RetainedPlansService, type SnapshotSource } from '../plans/RetainedPlansService'
import { orderPlanEntries } from '../plans/sources'

export type RunStatus = 'running' | QueryStatus | 'lost' | 'closed'
/**
 * An entry's key: an opaque id ResultsService mints when the entry joins its run, unique in the window and never reused.
 * It is not `setKey`: an entry maps to the stored result it currently shows, and state that belongs to the entry (its sort,
 * views, grid state, jobs) is kept by this key, so it stays with the entry when the entries around it come and go.
 */
export type EntryKey = string
/**
 * One result set of the run, named everywhere by its `key` (the grid's `data-result-entry`), never by its place in the
 * list. `ordinal` is an original result's number in its run (`descriptor.index + 1`); a result Varia made (a pivot, a
 * transpose, a diff) has none. `number` is what the entry is numbered by where it has no name of its own ("Result 4" in
 * its caption, on a job's strip, in a save's suggested name): the ordinal, or for a derived entry the next number after
 * the run's highest when it was appended, fixed for its life. That is the place it was appended at, and stays unique when
 * an entry before it has gone.
 */
export interface ResultSetEntry {
  readonly key: EntryKey; readonly ordinal?: number; readonly number: number
  readonly descriptor: ResultDescriptor; readonly handle: ResultHandle; readonly capturedPlan?: true; readonly label?: string
}
/** An entry's name: its label when Varia made it ("Pivot of Result 3"), else "Result N" by its number. */
export const entryName = (entry: Pick<ResultSetEntry, 'label' | 'number'>): string => entry.label ?? `Result ${entry.number}`
/** The entry of `sets` with the key, for a consumer that holds a published list (the service looks its own up in a map). */
export const entryOf = (sets: readonly ResultSetEntry[] | undefined, key: EntryKey | undefined): ResultSetEntry | undefined =>
  key === undefined ? undefined : sets?.find(entry => entry.key === key)
/**
 * A grid's sort and filters (results.view): its keys in order, with the text mode each was sorted by, its filters, and the
 * view the grid shows. While a view is built (`sorting`) the grid keeps showing what it showed; a failed one keeps the last
 * view, its keys and filters. `stale` is a view built while rows were still arriving: it is built again once they are all in.
 */
export interface GridSort {
  readonly keys: readonly ViewSortKey[]
  /** In order; each keeps rows among those the ones before it kept. */
  readonly filters: readonly GridFilter[]
  /** The filters `view` applied: a failed view goes back to them. */
  readonly applied: readonly GridFilter[]
  readonly view?: ResultView
  readonly sorting: boolean
  readonly approximate: boolean
  readonly stale: boolean
}
/** A grid filter: what the view is asked for (selected cells until the view resolves them to rows) and its words. */
export interface GridFilter {
  readonly filter: ViewFilter
  readonly label: string
  /** The label already says all it will (its values named, or none to name): building the view again reads none. */
  readonly named?: true
  /** A `groups` filter's distinct snapshot, which the grid keeps while a filter of its sort names it and then closes. */
  readonly list?: DistinctList
}
/** What a selection filters by: its values, other values, the range from its lowest to its highest, or no NULL in its column. */
export type SelectionFilter = 'in' | 'notIn' | 'between' | 'notNull'
/** How a header click or a command changes a column's place in the sort. */
export type { SortDirection } from '../grid/sort-keys'
/** A set that has all its rows, for sizing the stack to them: its rows, and whether its grid shows a strip (truncated or incomplete). */
export interface SettledSet { readonly rows: number; readonly strip: boolean }
/** The output pane's views: the stacked grids, Messages, and the run's execution plans (shown only when it returned some). */
export type OutputViewName = 'results' | 'messages' | 'plan' | 'statistics'
/** A set's key in a run: its generation and result id. */
export const setKey = (descriptor: Pick<ResultDescriptor, 'generation' | 'resultId'>): string => descriptor.generation + ':' + descriptor.resultId
/**
 * A copy or save of one result set. Its strip shows once it has run for 300 ms (`visible`); a save's clock starts when
 * main reports its file (`fileName`), after the save dialog closed.
 */
export interface ResultJob {
  readonly jobId: string; readonly kind: 'copy' | 'save'; readonly label: string
  /** The entry it copies or saves. */
  readonly entry: EntryKey
  readonly rowsDone: number; readonly rowsTotal: number; readonly startedAt: number; readonly visible: boolean; readonly fileName?: string
}
/** What the output pane shows for one query tab. */
export interface TabResults {
  readonly queryId: string; readonly startedAt: number; readonly status: RunStatus; readonly sets: readonly ResultSetEntry[]
  readonly planSets: readonly ResultSetEntry[]
  readonly messages: readonly MessageEntry[]; readonly messagesTruncated: boolean; readonly rowsRead: number
  /** How many of `messages`, first, are Varia's own notices (a new session) rather than SQL Server's. */
  readonly notices: number
  readonly completedBatches: number; readonly totalBatches: number; readonly summary?: QueryResult; readonly error?: string
  readonly view: OutputViewName; readonly manualView: boolean; readonly jobs: readonly ResultJob[]; readonly announcement: string
  /** Whether the Messages strip under the results is open: it opens itself when an error, PRINT or RAISERROR output arrives,
   *  until the user opens or closes it in this run (`stripChosen`). Only the user's choice opens it in a pane too short to show it. */
  readonly strip: boolean
  readonly stripChosen: boolean
  /** When the run ended, for its duration when it has no summary (main failed it, or the backend was lost). */
  readonly endedAt?: number
  /** How a run whose results were closed had ended. */
  readonly closedFrom?: Exclude<RunStatus, 'running' | 'closed'>
  /** The sets that have all their rows, by `setKey`. */
  readonly settled: ReadonlyMap<string, SettledSet>
  /** When `announcement` was set, on a counter that only grows (0 before the run's first), so the live region reads out
   *  only sentences newer than the moment it was shown. */
  readonly announced: number
  /** How the last save ended ("Saved 400 rows to results.csv."), shown in the toolbar for a few seconds; '' otherwise. */
  readonly jobNotice: string
  /** Each sorted grid's sort, by entry key. */
  readonly sorts: ReadonlyMap<EntryKey, GridSort>
  /** The highest number an entry of the run was given: the M of a grid's "Result N of M", which closing a result does not
   *  lower (so no grid reads "Result 3 of 2"). */
  readonly numbered: number
  /** The run's last result was closed one at a time (not by Close Results): its status and summary stay as they were, and
   *  the Results view stays, saying so, in place of "returned no result sets". Captured plans are not affected. */
  readonly emptied?: true
}
/** One grid's view, outside React and never in a snapshot: it survives tab switches, Ctrl+R and unmounting. */
export interface GridViewState {
  topRow: number; virtualTop: number; scrollLeft: number; widths?: Float64Array
  userSized?: Set<number>; sized: boolean; selection?: GridSelection
  /** A follow-tail grid (a live log): whether its last frame showed the last row. A grid built over a state with false
   *  opens where it was rather than at the tail. */
  following?: boolean
  /** How the view is drawn: as a table (absent), or transposed, its columns as rows. Nothing sets it yet but test mode. */
  orientation?: 'transposed'
  /** Transposed: the column whose value heads each drawn column in place of "Row N" (Using Column as Headers). */
  headerColumn?: number
  /** What the transposed view keeps apart from the table's: its scroll offsets, the width its drawn columns share and the
   *  columns sized apart from it (grid/uniform-layout.ts), whether the first rows have set that width, and the name column's
   *  width once the user has sized it. The selection is the one above, in the result's rows and columns, in both. */
  transposed?: { topRow: number; virtualTop: number; scrollLeft: number; width: number; overrides: Map<number, number>; sized: boolean; nameWidth?: number }
}
/**
 * A tab's stack, all of it by entry key: `weights` are the shares a splitter drag left (used while every entry of the run
 * has one), `focused` the entry whose grid last had the focus, `collapsed` the entries shown as their caption alone (a
 * caption toggles it), `grids` each grid's own state.
 */
export interface TabViewState { stackScrollTop: number; weights?: ReadonlyMap<EntryKey, number>; focused?: EntryKey; grids: Map<EntryKey, GridViewState>; collapsed: ReadonlySet<EntryKey> }
/** A mounted grid, for the commands that act on it. */
export interface GridController {
  selectAll(): void; repaint(): void; fitColumn(column: number): void
  /** Opens the header funnel's popover for a column (results grids). */
  filterColumn?(column: number): void
}
/** How a run ended: the summary, or main's failure (`code` BACKEND_LOST when the backend stopped), plus a notice to show first. */
export interface RunEnd { summary?: QueryResult; error?: string; code?: ErrorCode; notice?: string; planContext?: PlanExecutionContext }
/** Open Value in New Tab's outcome: whether a document opened, and what the banner says (a failure, or that it opened unformatted). */
export interface OpenedValue { readonly opened: boolean; readonly message?: string }

interface Run {
  readonly queryId: string
  readonly startedAt: number
  status: RunStatus
  sets: ResultSetEntry[]
  planSets: ResultSetEntry[]
  /** The sets' keys, so a thousand sets open in linear time. */
  readonly setKeys: Set<string>
  /** `sets` by entry key. */
  readonly entries: Map<EntryKey, ResultSetEntry>
  /** The highest number an entry of the run was given: a derived entry takes the next. */
  numbered: number
  /** `sets` is held by a published snapshot, so the next change copies it first. */
  setsPublished: boolean
  readonly rowsRead: Map<number, number>
  messages: MessageEntry[]
  notices: MessageEntry[]
  messagesTruncated: boolean
  completedBatches: number
  totalBatches: number
  summary?: QueryResult
  error?: string
  view: OutputViewName
  manualView: boolean
  strip: boolean
  stripManual: boolean
  settled: Map<string, SettledSet>
  /** `settled` is held by a published snapshot, so the next change copies it first. */
  settledPublished: boolean
  jobs: ResultJob[]
  announcement: string
  announced: number
  jobNotice: string
  subscription?: Disposable
  endedAt?: number
  closedFrom?: Exclude<RunStatus, 'running' | 'closed'>
  retaining?: Promise<void>
  /** By entry key. Replaced, never changed in place: snapshots share it. */
  sorts: ReadonlyMap<EntryKey, GridSort>
  /** The sort each grid is waiting for, by entry key. */
  readonly sorting: Map<EntryKey, AbortController>
  /** Each grid's views still open (its current one, the one it shows, and those superseded since), by entry key: a view
   *  closes only once the grid shows another or none, so a re-sort keeps painting the old order until the new one is read. */
  readonly held: Map<EntryKey, { shown?: ResultHandle; readonly views: Set<ResultView> }>
  /** Its last entry was closed by `removeEntry`. */
  emptied: boolean
}
interface RunningJob { job: ResultJob; readonly tabId: string; timer?: unknown }

const emptyView = (): TabViewState => ({ stackScrollTop: 0, grids: new Map(), collapsed: new Set() })

/** Result sets a run keeps (the backend keeps the same number) and the Messages entries it shows: the backend's, the errors
 *  it keeps past its cap, and its notes. */
export const resultLimits = { sets: 1000, messages: wire.messages.count + wire.messages.lateErrors + 8 } as const
const unavailable = 'These results are no longer available because the SQL backend restarted.'
const closedResults = 'These results were closed. Execute the query again to see them.'
const stillLoading = 'Save the results after this result set finishes loading.'
const stillSorting = 'Save the results after they are sorted.'
const saveCancelled = 'Saving was cancelled. The file was not written.'
/** Main's and the backend's own sentences for a save; anything else is prefixed. */
const saveSentences: ReadonlySet<string> = new Set<ErrorCode>(['EXPORT_FAILED', 'JOB_BUSY', 'RESULT_OPEN', 'RESULT_UNAVAILABLE', 'RESULT_NOT_FOUND'])
const sameMessages = (a: readonly MessageEntry[], b: readonly MessageEntry[]) => a.length === b.length && a.every((entry, index) => entry.text === b[index].text && entry.kind === b[index].kind)
const runStatus = (summary: QueryResult): RunStatus => summary.status
/** " 3 values were truncated." after a copy or save that wrote values the backend stored cut; '' otherwise. */
const truncatedClause = (cells: number): string => cells > 0 ? ` ${formatCount(cells)} ${cells === 1 ? 'value was' : 'values were'} truncated.` : ''
const held = (set: ResultSetEntry): boolean => { const state = set.handle.getSnapshot().state; return state !== 'lost' && state !== 'released' }
/** The document a link cell opens in: its kind, and the name its tabs count from (SSMS: XML_F52E2B61-…1.xml, ExecutionPlan1.sqlplan). */
const valueKinds: Readonly<Record<string, { kind: TextDocument['kind']; base?: string; extension: string }>> = {
  xml: { kind: 'xml', extension: '.xml' }, json: { kind: 'json', extension: '.json' }, plan: { kind: 'sqlplan', base: 'ExecutionPlan', extension: '.sqlplan' }
}
/**
 * Characters a file name cannot hold become '_', and so do bidirectional controls and line separators, with which a
 * column alias could make 'report\u202egpj.xml' read as another file type; a blank name becomes the kind's ('XML', 'JSON').
 */
function valueBase(column: ResultColumn, kind: TextDocument['kind']): string {
  const name = column.name.replace(/[\\/:*?"<>|\x00-\x1f\x7f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '_').trim().slice(0, 100)
  return name || kindInfo[kind].blankName
}
/** Save Results As's suggested name, '{tab}-Result{n}' for the entry numbered `number`, cut to the length main accepts
 *  (never inside a surrogate pair). */
export function suggestedName(baseName: string, number: number): string {
  const suffix = `-Result${number}`
  let end = Math.min(baseName.length, wire.jobs.suggestedName - suffix.length)
  if (end > 0 && end < baseName.length && /[\ud800-\udbff]/.test(baseName[end - 1])) end--
  return baseName.slice(0, end) + suffix
}

/**
 * Each query tab's results: the run's result sets (handles from ResultClient, opened as the backend announces them),
 * its streaming Messages, progress, and copy jobs. Events are applied as they arrive and published at most once per
 * frame; the summary is authoritative when the run ends. Results are released when the tab runs again, closes, or the
 * user closes them; changing the connection or database keeps them, as SSMS does.
 */
export class ResultsService extends SnapshotStore<Readonly<Record<string, TabResults>>> implements Disposable {
  private readonly client: Pick<ResultClient, 'open' | 'onQueryEvent' | 'applySummary' | 'release' | 'onGeneration'>
  private readonly events: EventBus
  private readonly api: Pick<VariaApi, 'copyResults' | 'saveResults' | 'cancelResultsJob' | 'onResultsJob'>
  private readonly documents: Pick<DocumentService, 'openText'> | undefined
  private readonly retainedPlans?: RetainedPlansService
  /** How text columns sort (queryResults.grid.sortText). */
  private readonly sortText: () => ViewSortMode
  /** The last number each value tab name used (XML_F52E2B61-…3.xml), for the window's lifetime. */
  private readonly valueNumbers = new Map<string, number>()
  private readonly frame: (callback: () => void) => void
  private readonly timers: Timers
  private readonly now: () => number
  private readonly newId: () => string
  private readonly runs = new Map<string, Run>()
  private readonly views = new Map<string, TabViewState>()
  /** Each tab's last choice to open or close the Messages strip: a strip the user opened starts open in the next run. */
  private readonly stripChoices = new Map<string, boolean>()
  /** Mounted grids, by entry key. */
  private readonly controllers = new Map<EntryKey, GridController>()
  private readonly dirty = new Set<string>()
  private readonly announcements = new Map<string, unknown>()
  /** The last selection each tab's live region read out: an arrow key that leaves its size unchanged says nothing. */
  private readonly selectionAnnounced = new Map<string, string>()
  /** Values being opened, by entry key, row and column: another click or Enter while one opens opens nothing more. */
  private readonly opening = new Set<string>()
  private readonly subscriptions: (() => void)[] = []
  private readonly noticeTimers = new Map<string, unknown>()
  private copying: RunningJob | undefined
  /** Saves by job id: main allows one per window, but a second request must not lose track of the first. */
  private readonly saves = new Map<string, RunningJob>()
  private readonly contextStore = new (class extends SnapshotStore<Readonly<Record<string, true>>> { set(value: Readonly<Record<string, true>>) { this.publish(value) } clear() { this.clearListeners() } })({})
  /** The tabs whose results can be saved or closed (`hasResults`); it publishes only when that set of tabs changes. */
  readonly context: ExternalStore<Readonly<Record<string, true>>> = this.contextStore
  private scheduled = false
  private disposed = false
  private announcedCount = 0
  private minted = 0

  constructor(o: {
    client: Pick<ResultClient, 'open' | 'onQueryEvent' | 'applySummary' | 'release' | 'onGeneration'>; api: Pick<VariaApi, 'copyResults' | 'saveResults' | 'cancelResultsJob' | 'onResultsJob'>; events: EventBus
    documents?: Pick<DocumentService, 'openText'>; frame?: (callback: () => void) => void; timers?: Timers; now?: () => number; newId?: () => string; retainedPlans?: RetainedPlansService
    sortText?: () => ViewSortMode
    /** Calls the listener when settings change; sorted grids sort again when the text mode did. Returns the unsubscribe. */
    onSortTextChange?: (listener: () => void) => () => void
  }) {
    super({})
    this.client = o.client
    this.events = o.events
    this.api = o.api
    this.documents = o.documents
    this.retainedPlans = o.retainedPlans
    this.sortText = o.sortText ?? (() => 'value')
    let sortText = this.sortText()
    if (o.onSortTextChange) this.subscriptions.push(o.onSortTextChange(() => { const next = this.sortText(); if (next !== sortText) { sortText = next; this.resort() } }))
    this.frame = o.frame ?? (callback => requestFrame(callback))
    this.timers = o.timers ?? browserTimers
    this.now = o.now ?? (() => Date.now())
    this.newId = o.newId ?? (() => crypto.randomUUID())
    const events = o.events.subscribe(event => { if (event.type === 'documents.closed') this.release(event.tabId) })
    // A new backend lost every result: nothing is left to save or close.
    const generations = this.client.onGeneration(() => this.updateContext())
    this.subscriptions.push(() => events.dispose(), () => generations.dispose(), this.api.onResultsJob(progress => this.progress(progress)))
  }

  /** A run starts: the tab's previous results are released, its copy cancelled and its selections cleared, and the
   *  run's events are followed from now on (before the script is sent). A running save goes on (the backend leases its
   *  result), so its strip moves to the new run. */
  begin(tabId: string, queryId: string, onSession?: (session: Extract<QueryEvent, { type: 'session.opened' }>) => void): void {
    if (this.disposed) return
    this.disposeRun(tabId)
    this.clearJobNotice(tabId)
    this.selectionAnnounced.delete(tabId)
    this.views.set(tabId, emptyView())
    const run: Run = {
      queryId, startedAt: this.now(), status: 'running', sets: [], planSets: [], setKeys: new Set(), entries: new Map(), numbered: 0, setsPublished: false, rowsRead: new Map(), messages: [], notices: [], messagesTruncated: false,
      completedBatches: 0, totalBatches: 0, view: 'messages', manualView: false, strip: this.stripChoices.get(tabId) === true, stripManual: false,
      settled: new Map(), settledPublished: false, jobs: this.savesOf(tabId), announcement: '', announced: 0, jobNotice: '', sorts: new Map(), sorting: new Map(), held: new Map(), emptied: false
    }
    run.subscription = this.client.onQueryEvent(queryId, event => {
      if (event.type === 'session.opened') {
        if (this.runs.get(tabId) === run && run.status === 'running') onSession?.(event)
      } else this.event(tabId, run, event)
    })
    this.runs.set(tabId, run)
    this.publishNow(tabId)
  }

  /** The run ended. The summary settles every set (opening any whose events were dropped) and replaces the streamed
   *  messages when they differ; events that arrive later are ignored. */
  finish(tabId: string, queryId: string, end: RunEnd): void | Promise<void> {
    const run = this.runs.get(tabId)
    // The tab closed before its run ended: nothing will show or close the sets the summary describes, so they go now.
    if (!run && end.summary && !this.disposed) {
      const sets = [...end.summary.resultSets, ...end.summary.planSets ?? []]
      if (sets.length) void this.client.release(sets.map(set => ({ generation: set.generation, resultId: set.resultId }))).catch(() => {})
    }
    if (!run || run.queryId !== queryId || run.status !== 'running') return
    run.subscription?.dispose()
    run.subscription = undefined
    const { summary } = end
    if (summary) {
      this.client.applySummary(summary)
      for (const descriptor of summary.resultSets) {
        this.opened(run, descriptor)
        this.settle(run, descriptor)
        run.rowsRead.set(descriptor.resultId, descriptor.rowsRead)
      }
      run.planSets = (summary.planSets ?? []).map((descriptor, index) => ({
        key: this.mint(), number: index + 1, descriptor, handle: this.client.open(descriptor), capturedPlan: true
      }))
      this.refreshSorts(tabId, run)
      if (!sameMessages(run.messages, summary.messages)) run.messages = summary.messages.slice(0, resultLimits.messages)
      // The error that ended the run is always in Messages, whatever the backend could keep there.
      if (summary.error && summary.status !== 'completed' && !run.messages.some(entry => entry.kind === 'error')) run.messages = [...run.messages, { text: summary.error.message, kind: 'error' }]
      run.messagesTruncated = summary.messagesTruncated
      run.completedBatches = summary.completedBatches
      run.totalBatches = summary.totalBatches
      run.summary = summary
      run.status = runStatus(summary)
    } else {
      run.status = end.code === 'BACKEND_LOST' ? 'lost' : 'failed'
      run.error = end.error ?? 'The query failed.'
      run.messages = [...run.messages, { text: run.error, kind: 'error' as const }].slice(-resultLimits.messages)
    }
    if (end.notice) run.notices = [{ text: end.notice, kind: 'info' }]
    run.endedAt = this.now()
    this.openStripFor(run, run.messages)
    // A run with sets stays on Results even when it failed: the strip under the grids shows its errors beside them.
    if (!run.manualView) run.view = run.sets.length ? 'results' : run.status === 'completed' && run.planSets.length ? 'plan' : 'messages'
    this.announce(tabId, completionSentence(run.status, run.sets.length, this.totalRows(run)))
    let retaining: Promise<void> | undefined
    if (end.planContext && this.retainedPlans) {
      const sources: SnapshotSource[] = []
      let available = 0
      for (const entry of orderPlanEntries([...run.planSets, ...run.sets.filter(set => set.descriptor.kind === 'executionPlan')], summary?.planOrder)) {
        const { descriptor, handle } = entry
        const snapshot = handle.getSnapshot()
        if (snapshot.state !== 'complete') continue
        available += snapshot.rowsAvailable
        for (let row = 0; row < snapshot.rowsAvailable && sources.length < retainedPlanLimits.documentsPerRun; row++) {
          sources.push({ key: `${descriptor.generation}:${descriptor.resultId}:${row}`, label: `${entry.capturedPlan ? 'Actual plan' : 'SQL-returned plan'} ${entry.number}, row ${row + 1}`,
            captureType: entry.capturedPlan ? 'actual' : 'query-returned', batchNumber: descriptor.batchNumber, iteration: descriptor.iteration,
            generation: descriptor.generation, resultId: descriptor.resultId, row, incomplete: snapshot.incomplete,
            read: async signal => {
              const value = await handle.getCell(row, 0, { signal })
              if (value.error || value.isNull) throw new Error('The original plan XML is unavailable.')
              return value
            } })
        }
      }
      const context = end.planContext, history = this.retainedPlans, endedAt = run.endedAt
      // Install ownership before capture publishes: a subscriber may close/reset output synchronously.
      let copied!: () => void, failed!: (error: unknown) => void
      const copying = retaining = run.retaining = new Promise<void>((resolve, reject) => { copied = resolve; failed = reject })
      // Once the copy has ended a close releases at once.
      const ended = () => { if (run.retaining === copying) run.retaining = undefined }
      void copying.then(ended, ended)
      void history.capture(context, {
        status: summary?.status ?? (end.code === 'BACKEND_LOST' ? 'lost' : 'failed'), endedAt,
        completedAt: summary?.completedAt, elapsedMs: summary?.elapsedMs, database: summary?.database,
        spid: summary?.spid, login: summary?.login, completedBatches: summary?.completedBatches, totalBatches: summary?.totalBatches,
        error: summary?.error?.message ?? end.error
      }, sources, Math.max(0, available - sources.length)).then(copied, failed)
    }
    this.publishNow(tabId)
    return retaining
  }

  /** The tab closed: its results are released and forgotten (a running save still finishes its file). */
  release(tabId: string): void {
    this.clearJobNotice(tabId)
    this.disposeRun(tabId)
    this.views.delete(tabId)
    this.stripChoices.delete(tabId)
    this.selectionAnnounced.delete(tabId)
    const timer = this.announcements.get(tabId)
    if (timer !== undefined) this.timers.clearTimeout(timer)
    this.announcements.delete(tabId)
    if (!Object.hasOwn(this.getSnapshot(), tabId)) return
    const next = { ...this.getSnapshot() }
    delete next[tabId]
    this.publish(next)
  }

  /** Close Results: the memory is freed now; Messages stay. */
  closeResults(tabId: string): void {
    const run = this.runs.get(tabId)
    if (!run || run.status === 'running' || run.status === 'closed') return
    this.drop(tabId, run, run.sets, run.planSets)
    run.closedFrom = run.status
    run.status = 'closed'
    run.emptied = false
    run.view = 'results'
    this.views.set(tabId, emptyView())
    this.publishNow(tabId)
  }

  /**
   * Closes one entry of a run that has ended (a caption's close button): it leaves the run and its result is released
   * (`drop`); the entries after it move up a place and keep their keys, numbers, names and state. A result made from it (a
   * pivot, a transpose, a diff) is a stored result of its own and stays, under its name. The run's status, summary and row
   * total do not change; closing its last entry marks it `emptied`. Unavailable while the query runs. False when there is
   * no such entry.
   */
  removeEntry(tabId: string, key: EntryKey): boolean {
    const run = this.runs.get(tabId), entry = run?.entries.get(key)
    if (!run || !entry || run.status === 'running' || run.status === 'closed') return false
    this.drop(tabId, run, [entry])
    if (run.sets.length === 0) run.emptied = true
    this.publishNow(tabId)
    return true
  }

  /** The tab's view state, created on first use. */
  viewState(tabId: string): TabViewState {
    let view = this.views.get(tabId)
    if (!view) this.views.set(tabId, view = emptyView())
    return view
  }
  /** The entry whose grid last had the focus, else the run's first: what a command acts on when it names no grid. */
  focusedEntry(tabId: string): ResultSetEntry | undefined {
    const run = this.runs.get(tabId), focused = this.views.get(tabId)?.focused
    return run && ((focused === undefined ? undefined : run.entries.get(focused)) ?? run.sets[0])
  }
  /** One grid's state: scroll, widths and selection. It is the entry's, wherever the entry stands. */
  gridState(tabId: string, key: EntryKey): GridViewState {
    const grids = this.viewState(tabId).grids
    let state = grids.get(key)
    if (state) return state
    state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }
    // Kept only for an entry the run has: a key that names none (a grid drawn from a snapshot the run has left behind)
    // gets a state of its own that nothing holds on to.
    if (this.runs.get(tabId)?.entries.has(key)) grids.set(key, state)
    return state
  }

  /** The user picked an output pane: automatic switching stops until the next run. */
  setView(tabId: string, view: OutputViewName): void {
    // An isolated estimate may own the output before this tab has ordinary results.
    this.events.emit({ type: 'query.outputSelected', tabId, view })
    const run = this.runs.get(tabId)
    if (!run || (run.view === view && run.manualView)) return
    run.view = view
    run.manualView = true
    this.publishNow(tabId)
  }

  /** The user opened or closed the Messages strip: it stays so for this run, and a strip opened starts open next time. */
  setStrip(tabId: string, open: boolean): void {
    const run = this.runs.get(tabId)
    if (!run) return
    this.stripChoices.set(tabId, open)
    if (run.strip === open && run.stripManual) return
    run.strip = open
    run.stripManual = true
    this.publishNow(tabId)
  }

  /** The grid a command acts on registers while it is mounted. */
  registerGrid(tabId: string, key: EntryKey, controller: GridController): Disposable {
    if (!this.entry(this.runs.get(tabId), key)) return { dispose: () => {} }
    this.controllers.set(key, controller)
    return { dispose: () => { if (this.controllers.get(key) === controller) this.controllers.delete(key) } }
  }
  /** Fitting uses the mounted grid's bounded measurement and current (possibly sorted) view. */
  canFitColumn(tabId: string, key: EntryKey, column: number): boolean {
    const set = this.entry(this.runs.get(tabId), key), state = set?.handle.getSnapshot().state
    return !!set && Number.isInteger(column) && column >= 0 && column < set.descriptor.columns.length && set.descriptor.columns[column].role !== 'tone'
      && state !== 'released' && state !== 'lost' && this.controllers.has(set.key)
  }
  fitColumn(tabId: string, key: EntryKey, column: number): void {
    const set = this.entry(this.runs.get(tabId), key)
    if (set && this.canFitColumn(tabId, set.key, column)) this.controllers.get(set.key)?.fitColumn(column)
  }
  selection(tabId: string, key: EntryKey): GridSelection | undefined {
    const set = this.entry(this.runs.get(tabId), key)
    const selection = set && this.views.get(tabId)?.grids.get(set.key)?.selection
    return selection && selection.entry === set.key ? selection : undefined
  }
  setSelection(tabId: string, key: EntryKey, selection: GridSelection | undefined): void {
    const set = this.entry(this.runs.get(tabId), key)
    if (!set) return
    this.gridState(tabId, set.key).selection = selection
    this.controllers.get(set.key)?.repaint()
  }
  /** Select All: an open-ended block that grows as rows stream in. */
  selectAll(tabId: string, key: EntryKey): void {
    const set = this.entry(this.runs.get(tabId), key)
    if (!set) return
    const controller = this.controllers.get(set.key)
    if (controller) controller.selectAll()
    else this.setSelection(tabId, set.key, selectAll(set.key, this.selection(tabId, set.key)?.active))
  }
  clearSelections(tabId: string): void {
    for (const [key, state] of this.views.get(tabId)?.grids ?? []) {
      state.selection = undefined
      this.controllers.get(key)?.repaint()
    }
  }

  /**
   * Copies the grid's selection: the backend formats it (Copy's TSV, with headers on request) and main writes the
   * clipboard. One copy runs per window, so a new one cancels the last. Resolves to the sentence the error banner shows
   * when it fails; a cancelled copy is silent.
   */
  async copy(tabId: string, key: EntryKey, headers: boolean): Promise<string | undefined> {
    const run = this.runs.get(tabId), set = this.entry(run, key), selection = set && this.selection(tabId, set.key)
    if (!run || !set || !selection) return undefined
    const state = set.handle.getSnapshot().state
    if (state === 'lost' || state === 'released') return state === 'lost' ? unavailable : closedResults
    const parts = copyPlan(selection, set.descriptor.columns.length)
    if (parts.length === 0) return undefined
    this.cancelRunning(this.copying)
    const jobId = this.newId()
    const running: RunningJob = { tabId, job: { jobId, kind: 'copy', entry: set.key, label: `Result ${set.number}`, rowsDone: 0, rowsTotal: 0, startedAt: this.now(), visible: false } }
    this.copying = running
    run.jobs = [...run.jobs, running.job]
    this.schedule(tabId)
    running.timer = this.timers.setTimeout(() => { running.timer = undefined; this.updateJob(running, { visible: true }) }, g.copyStripDelayMs)
    let result
    const view = run.sorts.get(set.key)?.view
    try { result = await this.api.copyResults({ jobId, generation: set.handle.key.generation, resultId: set.handle.key.resultId, headers, parts, ...view ? { viewId: view.viewId } : {} }) }
    finally { this.endJob(running) }
    if (result.ok) {
      const { rows, partial, truncatedCells } = result.value
      const sentence = `Copied ${formatCount(rows)} ${plural(rows, 'row')}${partial ? '; the query is still running.' : '.'}${truncatedClause(truncatedCells)}`
      // Values cut where they were stored are copied cut: that is shown, not only read out.
      if (truncatedCells > 0) this.notify(tabId, sentence)
      else this.announce(tabId, sentence)
      return undefined
    }
    if (result.code === 'CANCELLED') return undefined
    return result.code === 'TOO_LARGE' ? result.error : 'Could not copy the results: ' + result.error
  }

  /**
   * Save Results As for one grid: main asks for the file and the backend writes it (ResultTextWriter); only the file's
   * name comes back. The set must have finished loading. The save goes on when the tab runs again or closes (the backend
   * leases the result); Cancel, Escape and reloading the window stop it. Resolves to the sentence the error banner shows
   * when it fails; a cancelled dialog is silent, and the end of a save is announced and shown in the toolbar.
   */
  async saveAs(tabId: string, key: EntryKey, baseName: string): Promise<string | undefined> {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set) return undefined
    const snapshot = set.handle.getSnapshot()
    if (snapshot.state === 'lost' || snapshot.state === 'released') return snapshot.state === 'lost' ? unavailable : closedResults
    if (snapshot.state !== 'complete') return stillLoading
    const sort = run.sorts.get(set.key)
    // The file follows the grid's order, which a running or pending sort is about to change.
    if (sort && (sort.sorting || sort.stale || !sort.view)) return stillSorting
    const jobId = this.newId()
    const running: RunningJob = { tabId, job: { jobId, kind: 'save', entry: set.key, label: `Result ${set.number}`, rowsDone: 0, rowsTotal: snapshot.rowsAvailable, startedAt: this.now(), visible: false } }
    this.saves.set(jobId, running)
    this.clearJobNotice(tabId)
    run.jobs = [...run.jobs, running.job]
    this.schedule(tabId)
    let result
    try { result = await this.api.saveResults({ jobId, generation: set.handle.key.generation, resultId: set.handle.key.resultId, suggestedName: suggestedName(baseName, set.number), ...sort?.view ? { viewId: sort.view.viewId } : {} }) }
    finally { this.endJob(running) }
    if (this.disposed) return undefined
    if (result.ok) {
      if (!result.value) return undefined
      const { rows, truncatedCells, fileName } = result.value
      const text = `Saved ${formatCount(rows)} ${plural(rows, 'row')} to ${fileName}.${truncatedClause(truncatedCells)}`
      this.notify(running.tabId, text)
      // Also when the tab has closed meanwhile (the save outlives it), which leaves no toolbar to say so.
      this.events.emit({ type: 'results.saved', tabId: running.tabId, text })
      return undefined
    }
    if (result.code === 'CANCELLED') { this.notify(running.tabId, saveCancelled); return undefined }
    return result.code && saveSentences.has(result.code) ? result.error : 'Could not save the results: ' + result.error
  }

  /**
   * Open Value in New Tab for an XML, JSON or plan cell: the worker reads the whole stored value and formats it, and it
   * opens as a text document. A value the backend stored as a prefix opens unformatted, with a sentence saying so; a
   * NULL or unreadable value opens nothing.
   */
  async openValue(tabId: string, key: EntryKey, row: number, column: number, capturedPlan = false): Promise<OpenedValue> {
    // A captured plan's set is not one of the stack's entries: it is looked up among the run's plan sets.
    const run = this.runs.get(tabId), set = capturedPlan ? run?.planSets.find(plan => plan.key === key) : this.entry(run, key)
    const info = set?.descriptor.columns[column], spec = info?.role ? valueKinds[info.role] : undefined
    if (!set || !info || !spec || !this.documents) return { opened: false }
    const state = set.handle.getSnapshot().state
    if (state === 'lost' || state === 'released') return { opened: false, message: state === 'lost' ? unavailable : closedResults }
    const cell = `${set.key}:${row}:${column}`
    if (this.opening.has(cell)) return { opened: false }
    this.opening.add(cell)
    try {
      // Rows are the grid's: a sorted grid's are its view's positions.
      const handle = (capturedPlan ? undefined : run?.sorts.get(set.key)?.view) ?? set.handle
      const value = await handle.getCell(row, column, { format: spec.kind === 'json' ? 'json' : 'xml' })
      // A value read for a result closed meanwhile opens nothing.
      if (this.disposed || !this.has(tabId, run, set) || value.isNull || value.error) return { opened: false }
      const base = spec.base ?? valueBase(info, spec.kind), number = (this.valueNumbers.get(base + spec.extension) ?? 0) + 1
      this.valueNumbers.set(base + spec.extension, number)
      this.documents.openText({ name: `${base}${number}${spec.extension}`, text: value.text, kind: spec.kind })
      return { opened: true, ...value.truncated ? { message: `This ${kindInfo[spec.kind].value} value was truncated at 2,097,152 characters, so it opened unformatted.` } : {} }
    } catch (error) {
      // Its result was closed while the value was read: that is not a failure to report.
      if (!this.has(tabId, run, set)) return { opened: false }
      return { opened: false, message: 'Could not open the value: ' + (error instanceof Error ? error.message : 'The value could not be read.') }
    }
    finally { this.opening.delete(cell) }
  }

  /** A grid's sort, while it has one. */
  sortOf(tabId: string, key: EntryKey): GridSort | undefined {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    return set && run!.sorts.get(set.key)
  }

  /**
   * Sorts a grid by a column: alone, or with `add` as a further key after those it has (moved to the end when it is one).
   * `none` takes the column out of the sort; a grid left with no key shows its rows in the order SQL Server sent them.
   */
  sortBy(tabId: string, key: EntryKey, column: number, direction: SortDirection, add = false): void {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set || column < 0 || column >= set.descriptor.columns.length) return
    this.applySort(tabId, run, set.key, sortKeysBy(run.sorts.get(set.key)?.keys ?? [], column, direction, add, wire.views.maxKeys, (descending): ViewSortKey => ({ column, descending, mode: 'value' })))
  }

  /** A header's sort button (`cycleSortKeys`, which a live grid's header shares): ascending, then descending, then out of
   *  the sort. With `add`, the column changes in place among the keys (a new one goes last); without, it becomes the only key. */
  cycleSort(tabId: string, key: EntryKey, column: number, add = false): void {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set || column < 0 || column >= set.descriptor.columns.length) return
    this.applySort(tabId, run, set.key, cycleSortKeys(run.sorts.get(set.key)?.keys ?? [], column, add, wire.views.maxKeys, (descending): ViewSortKey => ({ column, descending, mode: 'value' })))
  }

  clearSort(tabId: string, key: EntryKey): void {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (run && set && run.sorts.get(set.key)?.keys.length) this.applySort(tabId, run, set.key, [])
  }

  /**
   * Filters a grid by its selection, which must lie in one column: rows with a selected value (`in`), without one
   * (`notIn`), from the lowest selected value to the highest (`between`), or, for the active cell's column, without NULL
   * (`notNull`). Values are equal as the column's collation and type say. A filter of the same kind on the column replaces
   * the one it has. False when the selection does not fit the filter.
   */
  filterSelection(tabId: string, key: EntryKey, kind: SelectionFilter): boolean {
    const run = this.runs.get(tabId), set = this.entry(run, key), target = this.filterTarget(tabId, key, kind)
    if (!run || !set || !target) return false
    const index = set.key
    const { column } = target
    const filter: ViewFilter = kind === 'notNull' ? { op: 'notIn', column, rows: [], nulls: true }
      : { op: kind, column, cells: { ranges: target.ranges, ...target.viewId === undefined ? {} : { viewId: target.viewId } } }
    const name = columnName(set.descriptor.columns, column)
    const item: GridFilter = kind === 'notNull' ? { filter, label: `${name} is not NULL`, named: true } : { filter, label: `${name}: filtering…` }
    // Exclude NULLs is a notIn of its own: it and Exclude Selected Values on a column each replace only their own kind.
    const same = (other: GridFilter) => other.filter.op === filter.op && 'column' in other.filter && other.filter.column === column && isNotNull(other.filter) === (kind === 'notNull')
    return this.addFilter(tabId, run, index, (run.sorts.get(index)?.filters ?? []).filter(other => !same(other)), item)
  }

  /** Whether `filterSelection` can filter the grid's selection that way. */
  canFilterSelection(tabId: string, key: EntryKey, kind: SelectionFilter): boolean { return !!this.filterTarget(tabId, key, kind) }

  /** Keeps a grid's rows whose values in the selected columns (every column with `allColumns`) repeat, each group together. */
  filterDuplicates(tabId: string, key: EntryKey, allColumns = false): boolean {
    const run = this.runs.get(tabId), set = this.entry(run, key), columns = this.duplicateColumns(tabId, key, allColumns)
    if (!run || !set || !columns) return false
    const index = set.key
    const names = set.descriptor.columns
    const label = filterLabel({ op: 'duplicates', columns }, names)
    const filters = (run.sorts.get(index)?.filters ?? []).filter(item => !(item.filter.op === 'duplicates' && sameColumns(item.filter.columns, columns)))
    return this.addFilter(tabId, run, index, filters, { filter: { op: 'duplicates', columns }, label, named: true })
  }

  /** Adds a filter after the grid's others, or at `at` among them (where the one it replaces stood, since filters apply in
   *  order and a duplicates filter after it counts only the rows it keeps); a grid that has as many as a view takes says
   *  so and keeps them. */
  private addFilter(tabId: string, run: Run, index: EntryKey, others: readonly GridFilter[], item: GridFilter, at = others.length): boolean {
    if (others.length >= wire.views.maxFilters) {
      this.notify(tabId, `Could not filter the results: a grid takes at most ${wire.views.maxFilters} filters. Remove one first.`)
      return false
    }
    this.applyView(tabId, run, index, run.sorts.get(index)?.keys ?? [], [...others.slice(0, at), item, ...others.slice(at)], 'filter')
    return true
  }

  /** Whether a grid's column can open the funnel's popover: a result's own column (not a diff's tone) on a mounted grid. */
  canFilterColumn(tabId: string, key: EntryKey, column: number): boolean {
    const set = this.entry(this.runs.get(tabId), key)
    return !!set && this.filterable(set) && Number.isInteger(column) && column >= 0 && column < set.descriptor.columns.length && set.descriptor.columns[column].role !== 'tone'
      && !!this.controllers.get(set.key)?.filterColumn
  }

  /** Opens the funnel's popover for a column (the grid menu's Filter Column Values, Alt+Down in a grid). */
  filterColumn(tabId: string, key: EntryKey, column: number): void {
    const set = this.entry(this.runs.get(tabId), key)
    if (set && this.canFilterColumn(tabId, set.key, column)) this.controllers.get(set.key)?.filterColumn?.(column)
  }

  /**
   * A column's distinct values for the funnel, kept in the backend as a snapshot (results.distinct): over the rows the
   * grid's other filters keep, so values the column's own value list drops can be ticked again. When the column has such a
   * filter the grid's view starts each value ticked only when it keeps it, as it does NULL. The view built for it is closed
   * once the snapshot is; the snapshot is the caller's to close, or to hand to `applyColumnFilter`.
   */
  async columnValues(tabId: string, key: EntryKey, column: number, o: { signal?: AbortSignal } = {}): Promise<DistinctList> {
    const run = this.runs.get(tabId), set = this.entry(run, key), sort = set && run?.sorts.get(set.key)
    if (!run || !set || !this.filterable(set)) throw new Error('These results are no longer available.')
    if (sort?.sorting) throw new Error('The results are still being sorted or filtered. Try again when they are shown.')
    const filters = sort?.filters ?? [], others = filters.filter(item => { const own = columnFilterKind(item.filter, column); return own === undefined || own === 'between' })
    const signal = o.signal ? { signal: o.signal } : {}
    if (others.length === filters.length) return (sort?.view ?? set.handle).distinct(column, signal)
    const base = others.length > 0 ? await set.handle.sort([], { filters: others.map(item => item.filter), ...signal }) : undefined
    try {
      return await (base ?? set.handle).distinct(column, { ...signal, ...sort?.view ? { kept: sort.view } : {} })
    } finally { void base?.close() }
  }

  /**
   * Applies the funnel's condition to a column: it replaces the column's filter of the same kind (its value list, its
   * range or its not-NULL), and `clear` takes all of the column's filters off. False when the grid cannot be filtered.
   */
  applyColumnFilter(tabId: string, key: EntryKey, column: number, condition: ColumnCondition): boolean {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set || !this.filterable(set) || !Number.isInteger(column) || column < 0 || column >= set.descriptor.columns.length) return false
    const index = set.key
    const filters = run.sorts.get(index)?.filters ?? [], kind = conditionKind(condition)
    const others = filters.filter(item => { const own = columnFilterKind(item.filter, column); return own === undefined || (kind !== undefined && !sameFilterFamily(own, kind)) })
    const filter = conditionFilter(condition, column)
    if (!filter) {
      if (others.length !== filters.length) this.applyView(tabId, run, index, run.sorts.get(index)?.keys ?? [], others, 'filter')
      return true
    }
    if ('rows' in filter && filter.rows.length > wire.views.maxFilterValues) {
      this.notify(tabId, `Could not filter the results: a filter holds at most ${formatCount(wire.views.maxFilterValues)} values.`)
      return false
    }
    if (condition.kind === 'list' && (condition.list.column !== column || set.handle.key.resultId !== condition.list.resultId || set.handle.key.generation !== condition.list.generation)) return false
    const name = columnName(set.descriptor.columns, column)
    const item: GridFilter = condition.kind === 'null' || condition.kind === 'notNull' ? { filter, label: `${name} is ${condition.kind === 'null' ? '' : 'not '}NULL`, named: true }
      : { filter, label: `${name}: filtering…`, ...condition.kind === 'list' ? { list: condition.list } : {} }
    // In the place of the first filter it replaces: before it, every filter is one of the others.
    const replaced = filters.findIndex(item => !others.includes(item))
    return this.addFilter(tabId, run, index, others, item, replaced < 0 ? others.length : replaced)
  }

  canFilterDuplicates(tabId: string, key: EntryKey, allColumns = false): boolean { return !!this.duplicateColumns(tabId, key, allColumns) }

  /** Takes one filter off a grid; the others apply again in their order. */
  removeFilter(tabId: string, key: EntryKey, at: number): void {
    const run = this.runs.get(tabId), set = this.entry(run, key), sort = set && run?.sorts.get(set.key)
    if (!run || !set || !sort || at < 0 || at >= sort.filters.length) return
    this.applyView(tabId, run, set.key, sort.keys, sort.filters.filter((_, position) => position !== at), 'filter')
  }

  clearFilters(tabId: string, key: EntryKey): void {
    const run = this.runs.get(tabId), set = this.entry(run, key), sort = set && run?.sorts.get(set.key)
    if (run && set && sort?.filters.length) this.applyView(tabId, run, set.key, sort.keys, [], 'filter')
  }

  /** The text sort mode changed: every grid sorted by a column the mode orders (text, xml, json, binary) sorts again. */
  resort(): void {
    for (const [tabId, run] of this.runs) for (const [index, sort] of run.sorts) {
      const columns = run.entries.get(index)?.descriptor.columns
      if (columns && sort.keys.some(key => columns[key.column] && lengthSortable(columns[key.column]))) this.applySort(tabId, run, index, sort.keys)
    }
  }

  /** The grid now shows `view` (undefined: its result's own order): the views it held before close. */
  viewShown(tabId: string, key: EntryKey, view: ResultHandle | undefined): void {
    const run = this.runs.get(tabId), set = this.entry(run, key), held = set && run?.held.get(set.key)
    if (!set || !held) return
    held.shown = view
    this.closeHeld(run!, set.key)
  }

  /** Cancels a copy or save by its job id (Cancel on its strip). */
  cancelJob(jobId: string): void {
    if (this.copying?.job.jobId === jobId) this.cancelRunning(this.copying)
    this.cancelRunning(this.saves.get(jobId))
  }
  /** Escape in a grid: cancels the tab's running copy, else its save once the file is chosen; false when there is none. */
  cancelTabJob(tabId: string): boolean {
    if (this.copying?.tabId === tabId) { this.cancelRunning(this.copying); return true }
    for (const save of this.saves.values()) {
      if (save.tabId === tabId && save.job.fileName !== undefined) { this.cancelRunning(save); return true }
    }
    return false
  }

  /**
   * A grid's selection changed: its size is read out when it differs from the last one read, so moving the active cell
   * with the arrow keys (which screen readers announce themselves) adds nothing.
   */
  announceSelection(tabId: string, text: string): void {
    if (this.selectionAnnounced.get(tabId) === text) return
    this.selectionAnnounced.set(tabId, text)
    this.announce(tabId, text)
  }

  /** The live region's sentence, after the 300 ms debounce; a copy's or save's outcome is read out again when repeated. */
  announce(tabId: string, text: string): void {
    const previous = this.announcements.get(tabId)
    if (previous !== undefined) this.timers.clearTimeout(previous)
    this.announcements.set(tabId, this.timers.setTimeout(() => {
      this.announcements.delete(tabId)
      const run = this.runs.get(tabId)
      if (!run) return
      // The same sentence again must still be read out: a zero-width space makes it a change.
      run.announcement = run.announcement === text ? text + '\u200b' : text
      run.announced = ++this.announcedCount
      this.publishNow(tabId)
    }, g.liveRegionMs))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.subscriptions) unsubscribe()
    for (const tabId of [...this.runs.keys()]) this.disposeRun(tabId)
    for (const save of this.saves.values()) this.cancelRunning(save)
    for (const timer of [...this.announcements.values(), ...this.noticeTimers.values()]) this.timers.clearTimeout(timer)
    this.announcements.clear()
    this.noticeTimers.clear()
    this.controllers.clear()
    this.contextStore.clear()
    this.clearListeners()
  }

  private event(tabId: string, run: Run, event: Exclude<QueryEvent, { type: 'session.opened' }>): void {
    if (this.runs.get(tabId) !== run || run.status !== 'running') return
    switch (event.type) {
      case 'resultSet.opened': case 'resultSet.closed':
        this.opened(run, event.descriptor)
        this.settle(run, event.descriptor)
        run.rowsRead.set(event.descriptor.resultId, event.descriptor.rowsRead)
        if (!run.manualView && run.sets.length > 0) run.view = 'results'
        if (event.descriptor.state === 'complete') this.refreshSorts(tabId, run)
        break
      case 'progress':
        run.completedBatches = event.completedBatches
        run.totalBatches = event.totalBatches
        for (const item of event.results) if (run.rowsRead.has(item.resultId)) run.rowsRead.set(item.resultId, item.rowsRead)
        break
      case 'messages':
        if (run.messages.length + event.messages.length > resultLimits.messages) run.messagesTruncated = true
        run.messages = [...run.messages, ...event.messages].slice(0, resultLimits.messages)
        this.openStripFor(run, event.messages)
        break
    }
    this.schedule(tabId)
  }

  /** Opens a set's handle once, keeping the sets in the backend's order; sets past the limit are not kept. */
  private opened(run: Run, descriptor: ResultDescriptor): void {
    const key = setKey(descriptor)
    if (run.setKeys.has(key) || run.sets.length >= resultLimits.sets) return
    run.setKeys.add(key)
    const handle = this.client.open(descriptor)
    if (run.setsPublished) { run.sets = run.sets.slice(); run.setsPublished = false }
    // Sets arrive in order, so the place is almost always the end.
    let at = run.sets.length
    while (at > 0 && (run.sets[at - 1].descriptor.index - descriptor.index || run.sets[at - 1].descriptor.resultId - descriptor.resultId) > 0) at--
    const entry: ResultSetEntry = { key: this.mint(), ordinal: descriptor.index + 1, number: descriptor.index + 1, descriptor, handle }
    run.numbered = Math.max(run.numbered, entry.number)
    run.sets.splice(at, 0, entry)
    run.entries.set(entry.key, entry)
  }

  /** Records a set that has all its rows (once): the stack sizes it to them from then on. */
  private settle(run: Run, descriptor: ResultDescriptor): void {
    const key = setKey(descriptor)
    if (descriptor.state !== 'complete' || !run.setKeys.has(key) || run.settled.has(key)) return
    if (run.settledPublished) { run.settled = new Map(run.settled); run.settledPublished = false }
    run.settled.set(key, { rows: descriptor.rowsStored, strip: descriptor.incomplete || descriptor.truncated !== undefined })
  }

  /** An error, PRINT or RAISERROR output opens the strip, unless the user opened or closed it in this run. SQL Server's other
   *  messages (warnings, SET STATISTICS output) show in it without opening it. */
  private openStripFor(run: Run, entries: readonly MessageEntry[]): void {
    if (run.strip || run.stripManual) return
    if (entries.some(entry => entry.kind === 'error' || entry.kind === 'print')) run.strip = true
  }

  private totalRows(run: Run): number {
    let rows = 0
    for (const value of run.rowsRead.values()) rows += value
    return rows
  }

  private progress(progress: ResultsJobProgress): void {
    if (this.copying?.job.jobId === progress.jobId) { this.updateJob(this.copying, { rowsDone: progress.rowsDone, rowsTotal: progress.rowsTotal }); return }
    const save = this.saves.get(progress.jobId)
    if (!save) return
    // The first report comes when the file is chosen: the strip's 300 ms start from then, not from the dialog.
    if (save.job.fileName === undefined) save.timer = this.timers.setTimeout(() => { save.timer = undefined; this.updateJob(save, { visible: true }) }, g.copyStripDelayMs)
    this.updateJob(save, { rowsDone: progress.rowsDone, ...progress.rowsTotal > 0 ? { rowsTotal: progress.rowsTotal } : {}, fileName: progress.fileName ?? save.job.fileName ?? '' })
  }

  /** The running saves a tab's new run keeps showing. */
  private savesOf(tabId: string): ResultJob[] {
    const jobs: ResultJob[] = []
    for (const save of this.saves.values()) if (save.tabId === tabId) jobs.push(save.job)
    return jobs
  }

  /** A save's outcome: announced, and shown in the toolbar until the next run or save, or for a few seconds. */
  /** Shows `text` in the tab's results toolbar for a few seconds and reads it out. */
  /** Adds a result Varia made from the run's own (a diff, results.diff) after the run ended, as its last set, named
   *  `label`; it is released with the run's others, and its rows are not counted among those the query read. `sources` are the set keys it was made from: a run without them (a
   *  newer one) does not take it. Returns its entry's key, or undefined when the run is gone, still running, lacks a source,
   *  or has its most sets; the result is then released, since nothing else would close it. */
  addSet(tabId: string, descriptor: ResultDescriptor, label: string, sources: readonly string[] = []): EntryKey | undefined {
    const run = this.runs.get(tabId)
    const key = setKey(descriptor)
    if (run?.setKeys.has(key)) return undefined
    if (!run || run.status === 'running' || run.status === 'closed' || run.sets.length >= resultLimits.sets || sources.some(source => !run.setKeys.has(source))) {
      void this.client.release([{ generation: descriptor.generation, resultId: descriptor.resultId }]).catch(() => {})
      return undefined
    }
    run.setKeys.add(key)
    if (run.setsPublished) { run.sets = run.sets.slice(); run.setsPublished = false }
    // Numbered once, for its life: an entry that goes before it does not renumber it, nor give its number to the next.
    const entry: ResultSetEntry = { key: this.mint(), number: ++run.numbered, descriptor, handle: this.client.open(descriptor), label }
    run.sets.push(entry)
    run.entries.set(entry.key, entry)
    if (run.settledPublished) { run.settled = new Map(run.settled); run.settledPublished = false }
    // Its grid always shows a strip: what was compared.
    run.settled.set(key, { rows: descriptor.rowsStored, strip: true })
    run.emptied = false
    run.view = 'results'
    this.schedule(tabId)
    return entry.key
  }

  notify(tabId: string, text: string): void {
    const run = this.runs.get(tabId)
    if (!run) return
    this.announce(tabId, text)
    this.clearJobNotice(tabId)
    run.jobNotice = text
    this.noticeTimers.set(tabId, this.timers.setTimeout(() => { this.noticeTimers.delete(tabId); this.clearJobNotice(tabId) }, g.jobNoticeMs))
    this.schedule(tabId)
  }
  private clearJobNotice(tabId: string): void {
    const timer = this.noticeTimers.get(tabId)
    if (timer !== undefined) this.timers.clearTimeout(timer)
    this.noticeTimers.delete(tabId)
    const run = this.runs.get(tabId)
    if (run?.jobNotice) { run.jobNotice = ''; this.schedule(tabId) }
  }

  private updateJob(running: RunningJob, patch: Partial<ResultJob>): void {
    const run = this.runs.get(running.tabId)
    const next = { ...running.job, ...patch }
    if (run) run.jobs = run.jobs.map(job => job === running.job ? next : job)
    running.job = next
    this.schedule(running.tabId)
  }

  private endJob(running: RunningJob): void {
    if (running.timer !== undefined) this.timers.clearTimeout(running.timer)
    running.timer = undefined
    if (this.copying === running) this.copying = undefined
    if (this.saves.get(running.job.jobId) === running) this.saves.delete(running.job.jobId)
    const run = this.runs.get(running.tabId)
    if (run && run.jobs.includes(running.job)) { run.jobs = run.jobs.filter(job => job !== running.job); this.schedule(running.tabId) }
  }

  private cancelRunning(running: RunningJob | undefined): void {
    if (!running) return
    void this.api.cancelResultsJob(running.job.jobId).catch(() => {})
  }

  /**
   * Sends a grid's sort to the backend (each key with the text mode now chosen), replacing the view it has once the new one
   * is built; a newer sort of the same grid cancels this one. No keys closes the view. A failure keeps the last view and
   * says why in the toolbar.
   */
  private applySort(tabId: string, run: Run, index: EntryKey, keys: readonly ViewSortKey[]): void {
    this.applyView(tabId, run, index, keys, run.sorts.get(index)?.filters ?? [], 'sort')
  }

  /** Builds a grid's view from its keys and filters (see applySort); a filter's selected cells come back as base rows,
   *  whose values then name the filter. */
  private applyView(tabId: string, run: Run, index: EntryKey, keys: readonly ViewSortKey[], filters: readonly GridFilter[], action: 'sort' | 'filter'): void {
    const set = run.entries.get(index)
    if (!set || this.disposed) return
    run.sorting.get(index)?.abort()
    run.sorting.delete(index)
    const current = run.sorts.get(index)
    if (keys.length === 0 && filters.length === 0) {
      // The view closes once the grid shows the rows in SQL Server's order (viewShown).
      this.setSort(tabId, run, index, undefined)
      this.closeHeld(run, index)
      return
    }
    const mode = this.sortText(), sort = keys.map(key => ({ column: key.column, descending: key.descending, mode }))
    const controller = new AbortController()
    run.sorting.set(index, controller)
    const applied = current?.view ? current.applied : []
    this.setSort(tabId, run, index, { keys: sort, filters, applied, ...current?.view ? { view: current.view } : {}, sorting: true, approximate: current?.approximate ?? false, stale: current?.stale ?? false })
    // No `replaces`: the old view stays readable until the grid has swapped to the new one, and a sort given up after the
    // backend built it cannot take the shown view with it.
    set.handle.sort(sort, { ...filters.length ? { filters: filters.map(item => item.filter) } : {}, signal: controller.signal }).then(view => {
      if (run.sorting.get(index) !== controller || this.runs.get(tabId) !== run) { void view.close(); return }
      run.sorting.delete(index)
      const held = run.held.get(index) ?? { views: new Set<ResultView>() }
      held.views.add(view)
      run.held.set(index, held)
      const resolved = filters.map((item, at): GridFilter => ({ ...item, filter: view.filters[at] ?? item.filter }))
      this.setSort(tabId, run, index, { keys: sort, filters: resolved, applied: resolved, view, sorting: false, approximate: view.approximate, stale: !view.complete })
      this.closeHeld(run, index)
      this.nameFilters(tabId, run, index, set)
      // The set finished while this view was built (refreshSorts skipped it): build it from every row now.
      if (!view.complete && set.handle.getSnapshot().state === 'complete') this.applyView(tabId, run, index, sort, resolved, action)
    }, (error: unknown) => {
      if (run.sorting.get(index) !== controller || this.runs.get(tabId) !== run) return
      run.sorting.delete(index)
      const last = run.sorts.get(index)
      this.setSort(tabId, run, index, last?.view ? { ...last, keys: last.view.keys, filters: last.applied, sorting: false } : undefined)
      // Names the filters a rebuild took over before their values were read.
      this.nameFilters(tabId, run, index, set)
      const reason = error instanceof Error ? error.message : 'The rows could not be sorted.'
      this.notify(tabId, (action === 'filter' ? 'Could not filter the results: ' : 'Could not sort the results: ') + reason)
    })
  }

  /** The column and cells a selection filter takes, or undefined when the selection does not fit it. */
  private filterTarget(tabId: string, key: EntryKey, kind: SelectionFilter): { column: number; ranges: [number, number][]; viewId?: number } | undefined {
    const run = this.runs.get(tabId), set = this.entry(run, key), selection = set && this.selection(tabId, set.key)
    if (!run || !set || !selection || !this.filterable(set)) return undefined
    const shown = run.held.get(set.key)?.shown as ResultView | undefined
    const rows = (shown ?? set.handle).getSnapshot().rowsAvailable, columns = set.descriptor.columns.length
    if (kind === 'notNull') return selection.active.column < columns ? { column: selection.active.column, ranges: [] } : undefined
    const blocks = resolveBlocks(selection, rows, columns)
    const column = blocks[0]?.left
    if (column === undefined || blocks.some(block => block.left !== column || block.right !== column)) return undefined
    const ranges = mergeRanges(blocks.map((block): [number, number] => [block.top, block.bottom - block.top + 1]))
    // More separate runs of rows than a filter takes cannot filter by them all.
    if (ranges.length > wire.views.maxFilterRanges || (kind === 'between' && ranges.reduce((sum, [, count]) => sum + count, 0) < 2)) return undefined
    return { column, ranges, ...shown ? { viewId: shown.viewId } : {} }
  }

  private duplicateColumns(tabId: string, key: EntryKey, allColumns: boolean): number[] | undefined {
    const run = this.runs.get(tabId), set = this.entry(run, key)
    if (!run || !set || !this.filterable(set)) return undefined
    const columns = set.descriptor.columns.length
    // A diff's hidden tone column (its last) is not one of the rows' values.
    const shownColumns = set.descriptor.columns.flatMap((item, column) => item.role === 'tone' ? [] : [column])
    if (allColumns) return shownColumns.length > 0 ? shownColumns : undefined
    const selection = this.selection(tabId, set.key)
    if (!selection) return undefined
    const shown = run.held.get(set.key)?.shown ?? set.handle
    const picked = new Set<number>()
    for (const block of resolveBlocks(selection, shown.getSnapshot().rowsAvailable, columns)) for (let column = block.left; column <= block.right; column++) if (set.descriptor.columns[column]?.role !== 'tone') picked.add(column)
    return picked.size > 0 ? [...picked].sort((a, b) => a - b) : undefined
  }

  /** A set whose rows the backend still holds, other than an execution plan's. */
  private filterable(set: ResultSetEntry): boolean {
    const state = set.handle.getSnapshot().state
    return state !== 'lost' && state !== 'released' && set.descriptor.kind !== 'executionPlan'
  }

  /** Names each filter of the grid's view by the values its rows hold: "name = 'x'", "name between 'a' and 'b'". */
  private nameFilters(tabId: string, run: Run, index: EntryKey, set: ResultSetEntry): void {
    const sort = run.sorts.get(index)
    if (!sort?.view || sort.sorting || sort.filters.every(item => item.named)) return
    const columns = set.descriptor.columns
    const named = sort.filters.map(async (item): Promise<GridFilter> => {
      const filter = item.filter
      if (item.named || filter.op === 'duplicates') return item
      if (filter.op === 'groups') {
        if (!('keep' in filter)) return item
        const resolved = filter as ResolvedGroupsFilter
        const texts = resolved.row === undefined || resolved.nulls ? [] : [await valueText(set.handle, resolved.row, resolved.column)]
        return texts.every(text => text !== undefined) ? { ...item, label: filterLabel(resolved, columns, texts), named: true } : { ...item, label: filterLabel(resolved, columns, texts) }
      }
      if (!('rows' in filter)) return item
      const wanted = filter.op === 'between' ? filter.rows : filter.rows.length === 1 && !filter.nulls ? filter.rows : []
      const texts = await Promise.all(wanted.map(row => valueText(set.handle, row, filter.column)))
      const label = filterLabel(filter as ResolvedViewFilter, columns, texts)
      // A value that could not be read is read again the next time the view is built.
      return texts.every(text => text !== undefined) ? { ...item, filter, label, named: true } : { ...item, filter, label }
    })
    void Promise.all(named).then(filters => {
      // Only onto the same sort: a view building since has its own filters, and names them when it is built.
      if (run.sorts.get(index) !== sort || this.runs.get(tabId) !== run) return
      this.setSort(tabId, run, index, { ...sort, filters, applied: filters })
    }, () => { /* Labels keep their words without values. */ })
  }

  /** Closes the grid's views but its current one and the one it shows. */
  private closeHeld(run: Run, index: EntryKey): void {
    const held = run.held.get(index)
    if (!held) return
    const keep = run.sorts.get(index)?.view
    for (const view of [...held.views]) {
      if (view === keep || view === held.shown) continue
      held.views.delete(view)
      void view.close()
    }
    if (held.views.size === 0) run.held.delete(index)
  }

  private setSort(tabId: string, run: Run, index: EntryKey, sort: GridSort | undefined): void {
    // A snapshot no filter of the grid's sort names any more (asked for, or applied) is closed: it went with its filter.
    const lists = (value: GridSort | undefined) => new Set([...value?.filters ?? [], ...value?.applied ?? []].flatMap(item => item.list ? [item.list] : []))
    const kept = lists(sort)
    for (const list of lists(run.sorts.get(index))) if (!kept.has(list)) void list.close()
    const next = new Map(run.sorts)
    if (sort) next.set(index, sort)
    else next.delete(index)
    run.sorts = next
    this.schedule(tabId)
  }

  /** Views built while rows were still arriving are built again once their set has every row. */
  private refreshSorts(tabId: string, run: Run): void {
    for (const [index, sort] of run.sorts) {
      if (sort.stale && !sort.sorting && run.entries.get(index)?.handle.getSnapshot().state === 'complete') this.applyView(tabId, run, index, sort.keys, sort.filters, sort.keys.length ? 'sort' : 'filter')
    }
  }

  /**
   * The one way results leave a run: closing one entry, Close Results, the run starting again and the tab closing all come
   * here. For each entry it gives up the sort or filter being built (a view that answers later is closed, not shown),
   * forgets the views its grid held and its sort (closing its filters' distinct snapshots), its grid's controller and
   * state, its share of the stack, its collapse and the focus, and cancels a copy of it; a save the backend already
   * accepted finishes under its lease. Then the stored results are released, in one request (main refuses requests past
   * 64 at a time, and a request closes 1,024 ids), which drops their views and snapshots in the backend and makes their
   * handles report them released, so work other services have in flight on them fails and is dropped. A retained-plan
   * copy in progress reads its results first. The caller publishes.
   */
  private drop(tabId: string, run: Run, entries: readonly ResultSetEntry[], plans: readonly ResultSetEntry[] = []): void {
    const gone = [...entries, ...plans]
    if (gone.length === 0) return
    const keys = new Set(gone.map(entry => entry.key))
    const view = this.views.get(tabId)
    let sorts: Map<EntryKey, GridSort> | undefined, collapsed: Set<EntryKey> | undefined, weights: Map<EntryKey, number> | undefined
    for (const entry of entries) {
      const key = entry.key
      run.sorting.get(key)?.abort()
      run.sorting.delete(key)
      // Releasing the result closes its views.
      run.held.delete(key)
      const sort = run.sorts.get(key)
      if (sort) {
        for (const list of new Set([...sort.filters, ...sort.applied].flatMap(item => item.list ? [item.list] : []))) void list.close()
        sorts ??= new Map(run.sorts)
        sorts.delete(key)
      }
      this.controllers.delete(key)
      run.entries.delete(key)
      run.setKeys.delete(setKey(entry.descriptor))
      if (run.settled.has(setKey(entry.descriptor))) {
        if (run.settledPublished) { run.settled = new Map(run.settled); run.settledPublished = false }
        run.settled.delete(setKey(entry.descriptor))
      }
      if (!view) continue
      view.grids.delete(key)
      if (view.collapsed.has(key)) { collapsed ??= new Set(view.collapsed); collapsed.delete(key) }
      // The others keep their shares of what is left.
      if (view.weights?.has(key)) { weights ??= new Map(view.weights); weights.delete(key) }
      if (view.focused === key) view.focused = undefined
    }
    if (sorts) run.sorts = sorts
    if (view && collapsed) view.collapsed = collapsed
    if (view && weights) view.weights = weights
    if (entries.length) { run.sets = run.sets.filter(entry => !keys.has(entry.key)); run.setsPublished = false }
    if (plans.length) run.planSets = run.planSets.filter(entry => !keys.has(entry.key))
    if (this.copying && this.runs.get(this.copying.tabId) === run && keys.has(this.copying.job.entry)) this.cancelRunning(this.copying)
    const released: ResultKey[] = gone.map(entry => entry.handle.key)
    const release = () => {
      void this.client.release(released).catch(() => {})
      for (const entry of gone) entry.handle.dispose()
    }
    // A close may race a bounded XML copy. The copy owns this temporary lease; history owns no handles.
    if (run.retaining) void run.retaining.then(release, release)
    else release()
  }

  /** Whether a run still shows an entry (or captured plan set): work that answers for one it does not is dropped. */
  private has(tabId: string, run: Run | undefined, entry: ResultSetEntry): boolean {
    return !!run && this.runs.get(tabId) === run && (entry.capturedPlan ? run.planSets.includes(entry) : run.entries.get(entry.key) === entry)
  }

  private disposeRun(tabId: string): void {
    const run = this.runs.get(tabId)
    if (!run) return
    run.subscription?.dispose()
    this.drop(tabId, run, run.sets, run.planSets)
    this.runs.delete(tabId)
  }

  private schedule(tabId: string): void {
    this.dirty.add(tabId)
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    this.frame(() => {
      this.scheduled = false
      if (this.disposed || this.dirty.size === 0) return
      const next = { ...this.getSnapshot() }
      for (const id of this.dirty) {
        const run = this.runs.get(id)
        if (run) next[id] = this.snapshotOf(run)
      }
      this.dirty.clear()
      this.publish(next)
    })
  }

  private publishNow(tabId: string): void {
    const run = this.runs.get(tabId)
    if (!run || this.disposed) return
    this.dirty.delete(tabId)
    this.publish({ ...this.getSnapshot(), [tabId]: this.snapshotOf(run) })
  }

  protected override publish(snapshot: Readonly<Record<string, TabResults>>): void {
    super.publish(snapshot)
    this.updateContext()
  }
  /** `hasResults` per tab: a set the backend still holds, in results neither closed nor lost with the backend. */
  private updateContext(): void {
    const current = this.contextStore.getSnapshot(), next: Record<string, true> = {}
    let changed = false
    for (const [tabId, run] of this.runs) {
      if (run.status === 'closed' || run.status === 'lost' || !(run.sets.some(held) || run.planSets.some(held))) continue
      next[tabId] = true
      if (!current[tabId]) changed = true
    }
    if (changed || Object.keys(current).length !== Object.keys(next).length) this.contextStore.set(next)
  }

  private snapshotOf(run: Run): TabResults {
    run.setsPublished = true
    run.settledPublished = true
    return {
      queryId: run.queryId, startedAt: run.startedAt, status: run.status, sets: run.sets, planSets: run.planSets,
      messages: run.notices.length ? [...run.notices, ...run.messages] : run.messages, notices: run.notices.length,
      messagesTruncated: run.messagesTruncated, rowsRead: this.totalRows(run), completedBatches: run.completedBatches, totalBatches: run.totalBatches,
      ...run.summary ? { summary: run.summary } : {}, ...run.error ? { error: run.error } : {}, view: run.view, manualView: run.manualView, strip: run.strip, stripChosen: run.stripManual, settled: run.settled,
      ...run.endedAt !== undefined ? { endedAt: run.endedAt } : {}, ...run.closedFrom ? { closedFrom: run.closedFrom } : {}, jobs: run.jobs, announcement: run.announcement, announced: run.announced,
      jobNotice: run.jobNotice, sorts: run.sorts, numbered: run.numbered, ...run.emptied ? { emptied: true as const } : {}
    }
  }

  private mint(): EntryKey { return 'e' + ++this.minted }

  private entry(run: Run | undefined, key: EntryKey): ResultSetEntry | undefined { return run?.entries.get(key) }
}

/** A column whose order Sort text by changes (ViewSorter.IsText in C#, plus binary for Bytes). */
const lengthTypes = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'sysname', 'xml', 'json'])
function lengthSortable(column: ResultColumn): boolean {
  if (column.wire === 'binary' || column.collation !== undefined || column.role === 'xml' || column.role === 'json') return true
  const cut = column.dataType.indexOf('(')
  return lengthTypes.has((cut < 0 ? column.dataType : column.dataType.slice(0, cut)).trim().toLowerCase())
}

const columnName = (columns: readonly ResultColumn[], column: number) => columns[column]?.name || noColumnName
const isNotNull = (filter: ViewFilter) => filter.op === 'notIn' && 'rows' in filter && filter.rows.length === 0 && !!filter.nulls
const sameColumns = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((column, at) => column === b[at])

/** [first, count] ranges sorted, with overlapping and adjacent ones joined. */
export function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const merged: [number, number][] = []
  for (const [first, count] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && first <= last[0] + last[1]) last[1] = Math.max(last[1], first + count - last[0])
    else merged.push([first, count])
  }
  return merged
}

/** A value as a filter's words show it: quoted, its first 24 characters, NULL bare. */
async function valueText(handle: ResultHandle, row: number, column: number): Promise<string | undefined> {
  try {
    const window = await handle.getWindow(row, 1, { colStart: column, colEnd: column + 1, display: true, maxCellChars: 64 })
    if (window.text.length === 0) return undefined
    if (window.flags[0] & 1) return 'NULL'
    const text = window.text[0].replace(/\s+/g, ' ')
    return `'${text.length > 24 ? text.slice(0, 24) + '…' : text}'`
  } catch { return undefined }
}

/** A resolved filter's words, with the texts of its rows' values where it names them (one value, or Between's two). */
export function filterLabel(filter: ResolvedViewFilter, columns: readonly ResultColumn[], texts: readonly (string | undefined)[] = []): string {
  if (filter.op === 'duplicates') return filter.columns.length === columns.filter(column => column.role !== 'tone').length ? 'Duplicate rows' : `Duplicates in ${filter.columns.map(column => columnName(columns, column)).join(' + ')}`
  const name = columnName(columns, filter.column)
  if (filter.op === 'between') return texts[0] && texts[1] ? `${name} between ${texts[0]} and ${texts[1]}` : `${name} between 2 values`
  const values = (filter.op === 'groups' ? filter.values : filter.rows.length) + (filter.nulls ? 1 : 0), not = filter.op === 'notIn' || (filter.op === 'groups' && !filter.keep)
  // A checklist that keeps nothing it names drops nothing either.
  if (values === 0) return `${name}: every value`
  if (values === 1 && filter.nulls) return `${name} is ${not ? 'not ' : ''}NULL`
  if (values === 1 && texts[0]) return `${name} ${not ? '≠' : '='} ${texts[0]}`
  return `${name} ${not ? 'not in' : 'in'} (${formatCount(values)} ${plural(values, 'value')})`
}

/** The columns a grid's filters name one by one (a value list, a range or not NULL): their header funnels show it. */
export function filteredColumns(sort: GridSort | undefined): ReadonlySet<number> {
  const columns = new Set<number>()
  for (const item of sort?.filters ?? []) if (item.filter.op !== 'duplicates') columns.add(item.filter.column)
  return columns
}
