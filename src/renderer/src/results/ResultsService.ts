import { limits as wire, type ErrorCode } from '../../../shared/ipc/wire/protocol'
import type { MessageEntry, QueryEvent, QueryResult, QueryStatus, ResultColumn, ResultDescriptor, ResultsJobProgress, VariaApi } from '../../../shared/contracts'
import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, ExternalStore } from '../core/types'
import { gridLimits as g } from '../grid/constants'
import { copyPlan, selectAll, type GridSelection } from '../grid/selection'
import { kindInfo } from '../documents'
import type { DocumentService, TextDocument } from '../services/documents'
import type { ResultClient, ResultHandle } from './ResultClient'
import type { ResultKey } from './worker-protocol'
import { completionSentence, formatCount, plural } from './status'

export type RunStatus = 'running' | QueryStatus | 'lost' | 'closed'
/** One result set of the run; `index` is its position in the stack (the grid's `data-result-index`). */
export interface ResultSetEntry { readonly index: number; readonly descriptor: ResultDescriptor; readonly handle: ResultHandle }
/** A set that has all its rows, for sizing the stack to them: its rows, and whether its grid shows a strip (truncated or incomplete). */
export interface SettledSet { readonly rows: number; readonly strip: boolean }
/** The output pane's views: the stacked grids, Messages, and the run's execution plans (shown only when it returned some). */
export type OutputViewName = 'results' | 'messages' | 'plan'
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
export interface RunEnd { summary?: QueryResult; error?: string; code?: ErrorCode; notice?: string }
/** Open Value in New Tab's outcome: whether a document opened, and what the banner says (a failure, or that it opened unformatted). */
export interface OpenedValue { readonly opened: boolean; readonly message?: string }

interface Run {
  readonly queryId: string
  readonly startedAt: number
  status: RunStatus
  sets: ResultSetEntry[]
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
}
interface RunningJob { job: ResultJob; readonly tabId: string; timer?: unknown }

const emptyView = (): TabViewState => ({ stackScrollTop: 0, focusedIndex: 0, grids: new Map(), collapsed: new Set() })

/** Result sets a run keeps (the backend keeps the same number) and the Messages entries it shows: the backend's, the errors
 *  it keeps past its cap, and its notes. */
export const resultLimits = { sets: 1000, messages: wire.messages.count + wire.messages.lateErrors + 8 } as const
const unavailable = 'These results are no longer available because the SQL backend restarted.'
const closedResults = 'These results were closed. Execute the query again to see them.'
const stillLoading = 'Save the results after this result set finishes loading.'
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
    documents?: Pick<DocumentService, 'openText'>; frame?: (callback: () => void) => void; timers?: Timers; now?: () => number; newId?: () => string
  }) {
    super({})
    this.client = o.client
    this.events = o.events
    this.api = o.api
    this.documents = o.documents
    this.frame = o.frame ?? (callback => { requestAnimationFrame(() => callback()) })
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
  begin(tabId: string, queryId: string): void {
    if (this.disposed) return
    this.disposeRun(tabId)
    this.clearJobNotice(tabId)
    this.selectionAnnounced.delete(tabId)
    this.views.set(tabId, emptyView())
    const run: Run = {
      queryId, startedAt: this.now(), status: 'running', sets: [], setKeys: new Set(), setsPublished: false, rowsRead: new Map(), messages: [], notices: [], messagesTruncated: false,
      completedBatches: 0, totalBatches: 0, view: 'messages', manualView: false, strip: this.stripChoices.get(tabId) === true, stripManual: false,
      settled: new Map(), settledPublished: false, jobs: this.savesOf(tabId), announcement: '', announced: 0, jobNotice: ''
    }
    run.subscription = this.client.onQueryEvent(queryId, event => this.event(tabId, run, event))
    this.runs.set(tabId, run)
    this.publishNow(tabId)
  }

  /** The run ended. The summary settles every set (opening any whose events were dropped) and replaces the streamed
   *  messages when they differ; events that arrive later are ignored. */
  finish(tabId: string, queryId: string, end: RunEnd): void {
    const run = this.runs.get(tabId)
    // The tab closed before its run ended: nothing will show or close the sets the summary describes, so they go now.
    if (!run && end.summary?.resultSets.length && !this.disposed) void this.client.release(end.summary.resultSets.map(set => ({ generation: set.generation, resultId: set.resultId }))).catch(() => {})
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
    if (!run.manualView) run.view = run.sets.length === 0 ? 'messages' : 'results'
    this.announce(tabId, completionSentence(run.status, run.sets.length, this.totalRows(run)))
    this.publishNow(tabId)
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
    this.closeHandles(run)
    run.sets = []
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

  /** The user picked Results, Messages or Execution plan: automatic switching stops until the next run. */
  setView(tabId: string, view: OutputViewName): void {
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
    try { result = await this.api.copyResults({ jobId, generation: set.handle.key.generation, resultId: set.handle.key.resultId, headers, parts }) }
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
    const jobId = this.newId()
    const running: RunningJob = { tabId, job: { jobId, kind: 'save', index, label: `Result ${index + 1}`, rowsDone: 0, rowsTotal: snapshot.rowsAvailable, startedAt: this.now(), visible: false } }
    this.saves.set(jobId, running)
    this.clearJobNotice(tabId)
    run.jobs = [...run.jobs, running.job]
    this.schedule(tabId)
    let result
    try { result = await this.api.saveResults({ jobId, generation: set.handle.key.generation, resultId: set.handle.key.resultId, suggestedName: suggestedName(baseName, index) }) }
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
  async openValue(tabId: string, index: number, row: number, column: number): Promise<OpenedValue> {
    const set = this.runs.get(tabId)?.sets[index], info = set?.descriptor.columns[column], spec = info?.role ? valueKinds[info.role] : undefined
    if (!set || !info || !spec || !this.documents) return { opened: false }
    const state = set.handle.getSnapshot().state
    if (state === 'lost' || state === 'released') return { opened: false, message: state === 'lost' ? unavailable : closedResults }
    const key = `${tabId}:${index}:${row}:${column}`
    if (this.opening.has(key)) return { opened: false }
    this.opening.add(key)
    try {
      const value = await set.handle.getCell(row, column, { format: spec.kind === 'json' ? 'json' : 'xml' })
      if (this.disposed || value.isNull || value.error) return { opened: false }
      const base = spec.base ?? valueBase(info, spec.kind), number = (this.valueNumbers.get(base + spec.extension) ?? 0) + 1
      this.valueNumbers.set(base + spec.extension, number)
      this.documents.openText({ name: `${base}${number}${spec.extension}`, text: value.text, kind: spec.kind })
      return { opened: true, ...value.truncated ? { message: `This ${kindInfo[spec.kind].value} value was truncated at 2,097,152 characters, so it opened unformatted.` } : {} }
    } catch (error) { return { opened: false, message: 'Could not open the value: ' + (error instanceof Error ? error.message : 'The value could not be read.') } }
    finally { this.opening.delete(key) }
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

  private event(tabId: string, run: Run, event: QueryEvent): void {
    if (this.runs.get(tabId) !== run || run.status !== 'running') return
    switch (event.type) {
      case 'resultSet.opened': case 'resultSet.closed':
        this.opened(run, event.descriptor)
        this.settle(run, event.descriptor)
        run.rowsRead.set(event.descriptor.resultId, event.descriptor.rowsRead)
        if (!run.manualView && run.sets.length > 0) run.view = 'results'
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

  /** One release for all of a run's sets: main refuses requests past 64 at a time, and a request closes 1,024 ids. */
  private closeHandles(run: Run): void {
    if (this.copying && this.runs.get(this.copying.tabId) === run) this.cancelRunning(this.copying)
    if (run.sets.length === 0) return
    const keys: ResultKey[] = run.sets.map(set => set.handle.key)
    void this.client.release(keys).catch(() => {})
    for (const set of run.sets) set.handle.dispose()
  }

  private disposeRun(tabId: string): void {
    const run = this.runs.get(tabId)
    if (!run) return
    run.subscription?.dispose()
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
      if (run.status === 'closed' || run.status === 'lost' || !run.sets.some(held)) continue
      next[tabId] = true
      if (!current[tabId]) changed = true
    }
    if (changed || Object.keys(current).length !== Object.keys(next).length) this.contextStore.set(next)
  }

  private snapshotOf(run: Run): TabResults {
    run.setsPublished = true
    run.settledPublished = true
    return {
      queryId: run.queryId, startedAt: run.startedAt, status: run.status, sets: run.sets, messages: run.notices.length ? [...run.notices, ...run.messages] : run.messages, notices: run.notices.length,
      messagesTruncated: run.messagesTruncated, rowsRead: this.totalRows(run), completedBatches: run.completedBatches, totalBatches: run.totalBatches,
      ...run.summary ? { summary: run.summary } : {}, ...run.error ? { error: run.error } : {}, view: run.view, manualView: run.manualView, strip: run.strip, stripChosen: run.stripManual, settled: run.settled,
      ...run.endedAt !== undefined ? { endedAt: run.endedAt } : {}, ...run.closedFrom ? { closedFrom: run.closedFrom } : {}, jobs: run.jobs, announcement: run.announcement, announced: run.announced,
      jobNotice: run.jobNotice
    }
  }
}
