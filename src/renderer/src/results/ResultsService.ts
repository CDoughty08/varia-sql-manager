import { limits as wire, type ErrorCode } from '../../../shared/ipc/wire/protocol'
import type { MessageEntry, QueryEvent, QueryResult, QueryStatus, ResultColumn, ResultDescriptor, ResultsJobProgress, VariaApi, ViewSortKey, ViewSortMode } from '../../../shared/contracts'
import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { requestFrame } from '../core/windows'
import { gridLimits as g } from '../grid/constants'
import { copyPlan, selectAll, type GridSelection } from '../grid/selection'
import { kindInfo } from '../documents'
import type { DocumentService, TextDocument } from '../services/documents'
import type { ResultClient, ResultHandle, ResultView } from './ResultClient'
import type { ResultKey } from './worker-protocol'
import { completionSentence, formatCount, plural } from './status'
import { retainedPlanLimits, type PlanExecutionContext, type RetainedPlansService, type SnapshotSource } from '../plans/RetainedPlansService'
import { orderPlanEntries } from '../plans/sources'

export type RunStatus = 'running' | QueryStatus | 'lost' | 'closed'
/** One result set of the run; `index` is its position in the stack (the grid's `data-result-index`). */
export interface ResultSetEntry { readonly index: number; readonly descriptor: ResultDescriptor; readonly handle: ResultHandle; readonly capturedPlan?: true }
/**
 * A grid's sort (results.view): its keys in order, with the text mode each was sorted by, and the view the grid shows.
 * While a sort runs (`sorting`) the grid keeps showing what it showed; a failed sort keeps the last view. `stale` is a view
 * sorted while rows were still arriving: it is sorted again once they are all in.
 */
export interface GridSort {
  readonly keys: readonly ViewSortKey[]
  readonly view?: ResultView
  readonly sorting: boolean
  readonly approximate: boolean
  readonly stale: boolean
}
/** How a header click or a command changes a column's place in the sort. */
export type SortDirection = 'ascending' | 'descending' | 'none'
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
  readonly jobId: string; readonly kind: 'copy' | 'save'; readonly index: number; readonly label: string
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
  /** Each sorted grid's sort, by set index. */
  readonly sorts: ReadonlyMap<number, GridSort>
}
/** One grid's view, outside React and never in a snapshot: it survives tab switches, Ctrl+R and unmounting. */
export interface GridViewState {
  topRow: number; virtualTop: number; scrollLeft: number; widths?: Float64Array
  userSized?: Set<number>; sized: boolean; selection?: GridSelection
  /** A follow-tail grid (a live log): whether its last frame showed the last row. A grid built over a state with false
   *  opens where it was rather than at the tail. */
  following?: boolean
}
/** `collapsed` holds the sets shown as their caption alone, by index (a set's caption toggles it). */
export interface TabViewState { stackScrollTop: number; weights?: number[]; focusedIndex: number; grids: Map<number, GridViewState>; collapsed: ReadonlySet<number> }
/** A mounted grid, for the commands that act on it. */
export interface GridController { selectAll(): void; repaint(): void }
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
  /** Replaced, never changed in place, so a published snapshot keeps the one it had. */
  sorts: ReadonlyMap<number, GridSort>
  /** The sort each grid is waiting for, by set index. */
  readonly sorting: Map<number, AbortController>
  /** Each grid's views still open (its current one, the one it shows, and those superseded since), by set index: a view
   *  closes only once the grid shows another or none, so a re-sort keeps painting the old order until the new one is read. */
  readonly held: Map<number, { shown?: ResultHandle; readonly views: Set<ResultView> }>
}
interface RunningJob { job: ResultJob; readonly tabId: string; timer?: unknown }

const emptyView = (): TabViewState => ({ stackScrollTop: 0, focusedIndex: 0, grids: new Map(), collapsed: new Set() })

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
/** Save Results As's suggested name, '{tab}-Result{n}', cut to the length main accepts (never inside a surrogate pair). */
export function suggestedName(baseName: string, index: number): string {
  const suffix = `-Result${index + 1}`
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
  private readonly controllers = new Map<string, GridController>()
  private readonly dirty = new Set<string>()
  private readonly announcements = new Map<string, unknown>()
  /** The last selection each tab's live region read out: an arrow key that leaves its size unchanged says nothing. */
  private readonly selectionAnnounced = new Map<string, string>()
  /** Values being opened, by tab, set, row and column: another click or Enter while one opens opens nothing more. */
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
      queryId, startedAt: this.now(), status: 'running', sets: [], planSets: [], setKeys: new Set(), setsPublished: false, rowsRead: new Map(), messages: [], notices: [], messagesTruncated: false,
      completedBatches: 0, totalBatches: 0, view: 'messages', manualView: false, strip: this.stripChoices.get(tabId) === true, stripManual: false,
      settled: new Map(), settledPublished: false, jobs: this.savesOf(tabId), announcement: '', announced: 0, jobNotice: '', sorts: new Map(), sorting: new Map(), held: new Map()
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
        index, descriptor, handle: this.client.open(descriptor), capturedPlan: true
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
    if (end.planContext && this.retainedPlans) {
      const sources: SnapshotSource[] = []
      let available = 0
      for (const entry of orderPlanEntries([...run.planSets, ...run.sets.filter(set => set.descriptor.kind === 'executionPlan')], summary?.planOrder)) {
        const { descriptor, handle } = entry
        const snapshot = handle.getSnapshot()
        if (snapshot.state !== 'complete') continue
        available += snapshot.rowsAvailable
        for (let row = 0; row < snapshot.rowsAvailable && sources.length < retainedPlanLimits.documentsPerRun; row++) {
          sources.push({ key: `${descriptor.generation}:${descriptor.resultId}:${row}`, label: `${entry.capturedPlan ? 'Actual plan' : 'SQL-returned plan'} ${entry.index + 1}, row ${row + 1}`,
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
      run.retaining = new Promise<void>((resolve, reject) => { copied = resolve; failed = reject })
      void history.capture(context, {
        status: summary?.status ?? (end.code === 'BACKEND_LOST' ? 'lost' : 'failed'), endedAt,
        completedAt: summary?.completedAt, elapsedMs: summary?.elapsedMs, database: summary?.database,
        spid: summary?.spid, login: summary?.login, completedBatches: summary?.completedBatches, totalBatches: summary?.totalBatches,
        error: summary?.error?.message ?? end.error
      }, sources, Math.max(0, available - sources.length)).then(copied, failed)
    }
    this.publishNow(tabId)
    return run.retaining
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
    for (const controller of run.sorting.values()) controller.abort()
    run.sorting.clear()
    run.held.clear()
    run.sorts = new Map()
    this.closeHandles(run)
    run.sets = []
    run.planSets = []
    run.setKeys.clear()
    run.closedFrom = run.status
    run.status = 'closed'
    run.view = 'results'
    run.settled = new Map()
    run.settledPublished = false
    this.views.set(tabId, emptyView())
    this.publishNow(tabId)
  }

  /** The tab's view state, created on first use. */
  viewState(tabId: string): TabViewState {
    let view = this.views.get(tabId)
    if (!view) this.views.set(tabId, view = emptyView())
    return view
  }
  /** One grid's state: scroll, widths and selection. */
  gridState(tabId: string, index: number): GridViewState {
    const grids = this.viewState(tabId).grids
    let state = grids.get(index)
    if (!state) grids.set(index, state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false })
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
  registerGrid(tabId: string, index: number, controller: GridController): Disposable {
    const key = tabId + ':' + index
    this.controllers.set(key, controller)
    return { dispose: () => { if (this.controllers.get(key) === controller) this.controllers.delete(key) } }
  }
  selection(tabId: string, index: number): GridSelection | undefined {
    const selection = this.views.get(tabId)?.grids.get(index)?.selection
    return selection?.resultIndex === index ? selection : undefined
  }
  setSelection(tabId: string, index: number, selection: GridSelection | undefined): void {
    if (!this.runs.get(tabId)?.sets[index]) return
    this.gridState(tabId, index).selection = selection
    this.controllers.get(tabId + ':' + index)?.repaint()
  }
  /** Select All: an open-ended block that grows as rows stream in. */
  selectAll(tabId: string, index: number): void {
    const controller = this.controllers.get(tabId + ':' + index)
    if (controller) controller.selectAll()
    else this.setSelection(tabId, index, selectAll(index, this.selection(tabId, index)?.active))
  }
  clearSelections(tabId: string): void {
    for (const [index, state] of this.views.get(tabId)?.grids ?? []) {
      state.selection = undefined
      this.controllers.get(tabId + ':' + index)?.repaint()
    }
  }

  /**
   * Copies the grid's selection: the backend formats it (Copy's TSV, with headers on request) and main writes the
   * clipboard. One copy runs per window, so a new one cancels the last. Resolves to the sentence the error banner shows
   * when it fails; a cancelled copy is silent.
   */
  async copy(tabId: string, index: number, headers: boolean): Promise<string | undefined> {
    const run = this.runs.get(tabId), set = run?.sets[index], selection = this.selection(tabId, index)
    if (!run || !set || !selection) return undefined
    const state = set.handle.getSnapshot().state
    if (state === 'lost' || state === 'released') return state === 'lost' ? unavailable : closedResults
    const parts = copyPlan(selection, set.descriptor.columns.length)
    if (parts.length === 0) return undefined
    this.cancelRunning(this.copying)
    const jobId = this.newId()
    const running: RunningJob = { tabId, job: { jobId, kind: 'copy', index, label: `Result ${index + 1}`, rowsDone: 0, rowsTotal: 0, startedAt: this.now(), visible: false } }
    this.copying = running
    run.jobs = [...run.jobs, running.job]
    this.schedule(tabId)
    running.timer = this.timers.setTimeout(() => { running.timer = undefined; this.updateJob(running, { visible: true }) }, g.copyStripDelayMs)
    let result
    const view = run.sorts.get(index)?.view
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
  async saveAs(tabId: string, index: number, baseName: string): Promise<string | undefined> {
    const run = this.runs.get(tabId), set = run?.sets[index]
    if (!run || !set) return undefined
    const snapshot = set.handle.getSnapshot()
    if (snapshot.state === 'lost' || snapshot.state === 'released') return snapshot.state === 'lost' ? unavailable : closedResults
    if (snapshot.state !== 'complete') return stillLoading
    const sort = run.sorts.get(index)
    // The file follows the grid's order, which a running or pending sort is about to change.
    if (sort && (sort.sorting || sort.stale || !sort.view)) return stillSorting
    const jobId = this.newId()
    const running: RunningJob = { tabId, job: { jobId, kind: 'save', index, label: `Result ${index + 1}`, rowsDone: 0, rowsTotal: snapshot.rowsAvailable, startedAt: this.now(), visible: false } }
    this.saves.set(jobId, running)
    this.clearJobNotice(tabId)
    run.jobs = [...run.jobs, running.job]
    this.schedule(tabId)
    let result
    try { result = await this.api.saveResults({ jobId, generation: set.handle.key.generation, resultId: set.handle.key.resultId, suggestedName: suggestedName(baseName, index), ...sort?.view ? { viewId: sort.view.viewId } : {} }) }
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
  async openValue(tabId: string, index: number, row: number, column: number, capturedPlan = false): Promise<OpenedValue> {
    const run = this.runs.get(tabId), set = (capturedPlan ? run?.planSets : run?.sets)?.[index]
    const info = set?.descriptor.columns[column], spec = info?.role ? valueKinds[info.role] : undefined
    if (!set || !info || !spec || !this.documents) return { opened: false }
    const state = set.handle.getSnapshot().state
    if (state === 'lost' || state === 'released') return { opened: false, message: state === 'lost' ? unavailable : closedResults }
    const key = `${tabId}:${capturedPlan}:${index}:${row}:${column}`
    if (this.opening.has(key)) return { opened: false }
    this.opening.add(key)
    try {
      // Rows are the grid's: a sorted grid's are its view's positions.
      const handle = (capturedPlan ? undefined : run?.sorts.get(index)?.view) ?? set.handle
      const value = await handle.getCell(row, column, { format: spec.kind === 'json' ? 'json' : 'xml' })
      if (this.disposed || value.isNull || value.error) return { opened: false }
      const base = spec.base ?? valueBase(info, spec.kind), number = (this.valueNumbers.get(base + spec.extension) ?? 0) + 1
      this.valueNumbers.set(base + spec.extension, number)
      this.documents.openText({ name: `${base}${number}${spec.extension}`, text: value.text, kind: spec.kind })
      return { opened: true, ...value.truncated ? { message: `This ${kindInfo[spec.kind].value} value was truncated at 2,097,152 characters, so it opened unformatted.` } : {} }
    } catch (error) { return { opened: false, message: 'Could not open the value: ' + (error instanceof Error ? error.message : 'The value could not be read.') } }
    finally { this.opening.delete(key) }
  }

  /** A grid's sort, while it has one. */
  sortOf(tabId: string, index: number): GridSort | undefined { return this.runs.get(tabId)?.sorts.get(index) }

  /**
   * Sorts a grid by a column: alone, or with `add` as a further key after those it has (moved to the end when it is one).
   * `none` takes the column out of the sort; a grid left with no key shows its rows in the order SQL Server sent them.
   */
  sortBy(tabId: string, index: number, column: number, direction: SortDirection, add = false): void {
    const run = this.runs.get(tabId), set = run?.sets[index]
    if (!run || !set || column < 0 || column >= set.descriptor.columns.length) return
    const keys = add ? (run.sorts.get(index)?.keys ?? []).filter(key => key.column !== column) : []
    if (direction !== 'none') keys.push({ column, descending: direction === 'descending', mode: 'value' })
    this.applySort(tabId, run, index, keys.slice(-wire.views.maxKeys))
  }

  /** A header's sort button: ascending, then descending, then out of the sort. With `add`, the column changes in place among
   *  the keys (a new one goes last); without, it becomes the only key. */
  cycleSort(tabId: string, index: number, column: number, add = false): void {
    const run = this.runs.get(tabId), keys = run?.sorts.get(index)?.keys ?? []
    if (!run) return
    const at = keys.findIndex(key => key.column === column), current = keys[at]
    // Without the modifier only the sole key cycles; any other click starts a new sort by the column, ascending.
    const cycles = add || keys.length === 1
    const next: SortDirection = !current || !cycles ? 'ascending' : current.descending ? 'none' : 'descending'
    if (!add || !current) return this.sortBy(tabId, index, column, next, add)
    const changed = next === 'none' ? keys.filter(key => key.column !== column) : keys.map(key => key.column === column ? { ...key, descending: true } : key)
    this.applySort(tabId, run, index, changed)
  }

  clearSort(tabId: string, index: number): void {
    const run = this.runs.get(tabId)
    if (run?.sorts.has(index)) this.applySort(tabId, run, index, [])
  }

  /** The text sort mode changed: every grid sorted by a column the mode orders (text, xml, json, binary) sorts again. */
  resort(): void {
    for (const [tabId, run] of this.runs) for (const [index, sort] of run.sorts) {
      const columns = run.sets[index]?.descriptor.columns
      if (columns && sort.keys.some(key => columns[key.column] && lengthSortable(columns[key.column]))) this.applySort(tabId, run, index, sort.keys)
    }
  }

  /** The grid now shows `view` (undefined: its result's own order): the views it held before close. */
  viewShown(tabId: string, index: number, view: ResultHandle | undefined): void {
    const run = this.runs.get(tabId), held = run?.held.get(index)
    if (!held) return
    held.shown = view
    this.closeHeld(run!, index)
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
    run.sets.splice(at, 0, { index: at, descriptor, handle })
    for (let index = at + 1; index < run.sets.length; index++) run.sets[index] = { ...run.sets[index], index }
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
  private notify(tabId: string, text: string): void {
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
  private applySort(tabId: string, run: Run, index: number, keys: readonly ViewSortKey[]): void {
    const set = run.sets[index]
    if (!set || this.disposed) return
    run.sorting.get(index)?.abort()
    run.sorting.delete(index)
    const current = run.sorts.get(index)
    if (keys.length === 0) {
      // The view closes once the grid shows the rows in SQL Server's order (viewShown).
      this.setSort(tabId, run, index, undefined)
      this.closeHeld(run, index)
      return
    }
    const mode = this.sortText(), sort = keys.map(key => ({ column: key.column, descending: key.descending, mode }))
    const controller = new AbortController()
    run.sorting.set(index, controller)
    this.setSort(tabId, run, index, { keys: sort, ...current?.view ? { view: current.view } : {}, sorting: true, approximate: current?.approximate ?? false, stale: current?.stale ?? false })
    // No `replaces`: the old view stays readable until the grid has swapped to the new one, and a sort given up after the
    // backend built it cannot take the shown view with it.
    set.handle.sort(sort, { signal: controller.signal }).then(view => {
      if (run.sorting.get(index) !== controller || this.runs.get(tabId) !== run) { void view.close(); return }
      run.sorting.delete(index)
      const held = run.held.get(index) ?? { views: new Set<ResultView>() }
      held.views.add(view)
      run.held.set(index, held)
      this.setSort(tabId, run, index, { keys: sort, view, sorting: false, approximate: view.approximate, stale: !view.complete })
      this.closeHeld(run, index)
      // The set finished while this sort ran (refreshSorts skipped it): sort its every row now.
      if (!view.complete && set.handle.getSnapshot().state === 'complete') this.applySort(tabId, run, index, sort)
    }, (error: unknown) => {
      if (run.sorting.get(index) !== controller || this.runs.get(tabId) !== run) return
      run.sorting.delete(index)
      const last = run.sorts.get(index)
      this.setSort(tabId, run, index, last?.view ? { ...last, keys: last.view.keys, sorting: false } : undefined)
      this.notify(tabId, 'Could not sort the results: ' + (error instanceof Error ? error.message : 'The rows could not be sorted.'))
    })
  }

  /** Closes the grid's views but its current one and the one it shows. */
  private closeHeld(run: Run, index: number): void {
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

  private setSort(tabId: string, run: Run, index: number, sort: GridSort | undefined): void {
    const next = new Map(run.sorts)
    if (sort) next.set(index, sort)
    else next.delete(index)
    run.sorts = next
    this.schedule(tabId)
  }

  /** Views sorted while rows were still arriving are sorted again once their set has every row. */
  private refreshSorts(tabId: string, run: Run): void {
    for (const [index, sort] of run.sorts) {
      if (sort.stale && !sort.sorting && run.sets[index]?.handle.getSnapshot().state === 'complete') this.applySort(tabId, run, index, sort.keys)
    }
  }

  /** One release for all of a run's sets: main refuses requests past 64 at a time, and a request closes 1,024 ids. */
  private closeHandles(run: Run): void {
    if (this.copying && this.runs.get(this.copying.tabId) === run) this.cancelRunning(this.copying)
    const sets = [...run.sets, ...run.planSets]
    if (sets.length === 0) return
    const keys: ResultKey[] = sets.map(set => set.handle.key)
    const release = () => {
      void this.client.release(keys).catch(() => {})
      for (const set of sets) set.handle.dispose()
    }
    // Close Results/tab may race a bounded XML copy. The copy owns this temporary lease; history owns no handles.
    if (run.retaining) void run.retaining.then(release, release)
    else release()
  }

  private disposeRun(tabId: string): void {
    const run = this.runs.get(tabId)
    if (!run) return
    run.subscription?.dispose()
    // Releasing a set frees its views too.
    for (const controller of run.sorting.values()) controller.abort()
    run.sorting.clear()
    run.held.clear()
    this.closeHandles(run)
    this.runs.delete(tabId)
    for (const key of [...this.controllers.keys()]) if (key.startsWith(tabId + ':')) this.controllers.delete(key)
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
      jobNotice: run.jobNotice, sorts: run.sorts
    }
  }
}

/** A column whose order Sort text by changes (ViewSorter.IsText in C#, plus binary for Bytes). */
const lengthTypes = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'sysname', 'xml', 'json'])
function lengthSortable(column: ResultColumn): boolean {
  if (column.wire === 'binary' || column.collation !== undefined || column.role === 'xml' || column.role === 'json') return true
  const cut = column.dataType.indexOf('(')
  return lengthTypes.has((cut < 0 ? column.dataType : column.dataType.slice(0, cut)).trim().toLowerCase())
}
