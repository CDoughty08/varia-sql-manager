import type { ConnectionInfo, QueryEvent, QueryResult, VariaApi } from '../../../shared/contracts'
import type { RestoredJob } from '../../../shared/bigquery/jobs'
import type { BigQueryPreviewTarget } from '../../../shared/bigquery/objects'
import { estimatedPlanCacheCharacters, type EstimatedPlanMode, type EstimatedPlanResult } from '../../../shared/estimated-plans'
import type { ErrorCode } from '../../../shared/ipc/wire/protocol'
import { sessionCloseNoteText, sessionPromptLimits, type SessionAction, type SessionCloseNote, type SessionJob, type SessionLocationSwitch, type SessionPlanEntry } from '../../../shared/sessions'
import { defaultSettings, type SettingsValues } from '../../../shared/settings/catalog'
import { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { OutputViewName, ResultsService } from '../results/ResultsService'
import { isQueryDocument, type SessionNotice } from '../documents'
import { DocumentService } from './documents'
import { ClientStatisticsService } from '../statistics/ClientStatisticsService'
import type { PlanExecutionContext, RetainedPlansService } from '../plans/RetainedPlansService'
import { isLiveConnection, type ConnectionAvailability } from './connection-availability'

/** `attach`: a re-attach to a BigQuery job (query.attach), which Stop cancels as it would the query. */
export interface RunningQuery { readonly queryId: string; readonly connectionId: string; readonly startedAt: number; readonly kind?: 'estimate' | 'attach'; readonly estimateMode?: EstimatedPlanMode; readonly jobId?: string; /** BigQuery: the dry run's estimate as the run started, which the job prompt names. */ readonly estimateBytes?: number }
/** A BigQuery job the tab holds but does not follow (docs/bigquery.md, Re-attaching to jobs): handed back by a restore, kept
 *  when the backend was lost mid-job, or left running (`detached`, Leave it running on Close Results). */
export type TabJob = RestoredJob
export interface EstimatedPlanState { readonly requestId: string; readonly mode?: EstimatedPlanMode; readonly result?: EstimatedPlanResult; readonly error?: string; readonly loading?: true; readonly view?: OutputViewName }
/** The tab's SQL session as its execution reported it: its SPID and login, read when it opened (SSMS's status bar
 *  shows them). It belongs to the connection it ran on, so a query moved elsewhere (or a connection lost) no longer has
 *  it. Its open transaction is not kept here: it is read from the session only when the session is about to end. */
export interface QuerySession { readonly connectionId: string; readonly spid?: number; readonly login?: string }
/** Retained output belongs to the execution's original transport, even when its tab later reconnects elsewhere. */
export interface QueryProvenance { readonly queryId: string; readonly connectionId: string; readonly generation: number; readonly database: string; readonly targetId?: string }
/** A tab's last run: its summary (the rows stay in the backend; ResultsService shows them) or main's failure. */
export interface QueryState {
  /** The tab's BigQuery jobs it holds without following them, newest last: re-attached once its connection is live. */
  readonly jobs?: readonly TabJob[]
  readonly running?: RunningQuery; readonly summary?: QueryResult; readonly error?: string; readonly session?: QuerySession; readonly provenance?: QueryProvenance; readonly estimated?: EstimatedPlanState; readonly livePlan?: { queryId: string; connectionId: string } }
export type QueryApi = Pick<VariaApi, 'execute' | 'cancel' | 'confirmSessions' | 'querySessionState'> & Partial<Pick<VariaApi, 'estimatePlan' | 'attach' | 'dropJobRecords' | 'cancelRestoredJobs' | 'confirmRunningJob'>>
export type QuerySnapshot = Readonly<Record<string, QueryState>>
/** The last reported session only belongs to a tab while it is still on that live connection. */
export function liveQuerySession(query: QueryState | undefined, connection: { readonly id: string; readonly lost?: true } | undefined): { spid: number; login?: string } | undefined {
  const session = query?.session
  if (connection && !connection.lost && session?.connectionId === connection.id && session.spid !== undefined)
    return { spid: session.spid, login: session.login }
}
/** How each tab's session ends after the user answered: its open transaction committed or rolled back first, or its
 *  BigQuery job left running or cancelled. Tabs it does not name have nothing to end. */
export type SessionPlan = ReadonlyMap<string, SessionPlanEntry>
/** Approved choices without cancellation or session completion. The coordinator revalidates before applying them. */
export interface PreparedSessions {
  readonly plan: SessionPlan
  readonly stopping: readonly { readonly id: string; readonly queryId: string }[]
  readonly current: () => boolean
}
/** An idle session's open transaction as read just before it ends; `unchecked` means it may hold one. */
export interface TransactionState { readonly transactions: number; readonly unchecked?: true }
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'The operation failed.'
export const newSessionMessage = 'This query opened a new SQL session. The previous session ended when the SQL backend restarted, so its SET options, temporary tables, and open transaction no longer exist.'
export const lostSessionMessage = 'This query opened a new SQL session. The previous session was lost (SQL Server ended it, or its connection broke), so SQL Server rolled back its open transaction, and its SET options and temporary tables no longer exist.'
const noticeMessages: Readonly<Record<SessionNotice, string>> = { restarted: newSessionMessage, lost: lostSessionMessage }
/** The `lost` notice for a BigQuery query: BigQuery ends a session itself (BigQueryService.ExpiredNotice says the same). */
export const bigQueryLostSessionMessage = 'This query started a new BigQuery session. The previous session expired (BigQuery ends a session after 24 hours idle or 7 days), so its temp tables, variables and any open transaction are gone.'
/** A live connection: its Advanced properties' command timeout, when the profile set one, wins over Tools › Options. */
type QueryConnection = ConnectionInfo & ConnectionAvailability & { readonly targetId?: string; readonly options?: { readonly provider?: string; readonly advanced?: { readonly commandTimeout?: number } } }
/** Failures after which the tab has no session, so no open transaction. */
const sessionGone: ReadonlySet<ErrorCode | undefined> = new Set<ErrorCode | undefined>(['SESSION_LOST', 'SESSION_CLOSED', 'NOT_CONNECTED', 'CONNECTION_LOST', 'BACKEND_LOST'])
/** How long ending sessions waits for the queries it cancelled to stop; their sessions close (and roll back) either way. */
export const cancelSettleMs = 15_000
/** Requests ending sessions keeps in flight at once (state reads before the prompt, then cancels): Close All may cover
 *  hundreds of tabs, and main keeps only 32 requests in reserve for the control lane once 256 scripts are running. */
export const sessionRequests = 8
/** How long the state reads before a prompt may take in all; a session not read by then may hold a transaction, so an
 *  unresponsive backend or server delays the prompt by this much, not by every read's deadline in turn. */
export const stateBudgetMs = 5_000
const nothingOpen: TransactionState = { transactions: 0 }
const mayBeOpen: TransactionState = { transactions: 0, unchecked: true }

const backendGone: ReadonlySet<ErrorCode | undefined> = new Set<ErrorCode | undefined>(['BACKEND_LOST', 'CONNECTION_LOST', 'NOT_CONNECTED'])
/**
 * The jobs a tab holds after a run (docs/bigquery.md, Re-attaching to jobs). Leave it running keeps the run's running jobs
 * detached. A lost backend or connection keeps them (and a re-attach's own job) to re-attach to. A summary otherwise means
 * the run's jobs reached the tab; a normal run waited behind the detached ones, and a re-attach leaves the others for theirs.
 * Any other failure of a re-attach (Stop cancels its job; another principal's job; results gone) drops its job, so a
 * re-attach is never retried in a loop.
 */
export function heldAfter(attach: TabJob | undefined, held: readonly TabJob[] = [], reported: readonly TabJob[], summary: QueryResult | undefined, code: ErrorCode | undefined): TabJob[] {
  const own = reported.length ? reported : attach ? [attach] : []
  if (summary?.status === 'detached') return [...held, ...own.filter(job => job.state === 'running').map(job => ({ ...job, detached: true }))]
  if (summary) return attach || summary.status === 'superseded' ? [...held] : held.filter(job => !job.detached)
  if (backendGone.has(code)) return [...held, ...own.filter(job => job.state === 'running' || job === attach)]
  return [...held]
}
const jobList = (ids: readonly string[]) => ids.length === 1 ? `BigQuery job ${ids[0]} is` : `BigQuery jobs ${ids.join(', ')} are`
/** A run whose backend or connection was lost while its job ran: the job carries on in BigQuery. */
export const jobStillRunning = (ids: readonly string[]) => `${jobList(ids)} still running in BigQuery. Varia re-attaches to ${ids.length === 1 ? 'it' : 'them'} once this query's connection is back.`
/** A restored tab that is not connected: its job from the last session runs on unseen otherwise. */
export const restoredJobRunning = (ids: readonly string[]) => `${ids.length === 1 ? `BigQuery job ${ids[0]} from the last session is` : `BigQuery jobs ${ids.join(', ')} from the last session are`} still running: Reconnect to re-attach.`
/** Idle BigQuery sessions whose ABORT_SESSION failed (a Disconnect, a Reload or a backend restart). */
export const failedAbortsText = (count: number) => `Varia could not end ${count === 1 ? 'an idle BigQuery session' : `${count} idle BigQuery sessions`}. Any transaction in ${count === 1 ? 'it' : 'them'} stays open until ${count === 1 ? 'it expires' : 'they expire'}, other transactions on ${count === 1 ? 'its' : 'their'} tables fail meanwhile, and ${count === 1 ? 'its' : 'their'} temporary tables are billed as storage. Varia tries again the next time the connection reaches BigQuery.`
/** BigQuery's estimate and prompts before a run: the text, where it starts in the document (a selection's line and
 *  column, for dry-run markers), and a signal Cancel aborts. Resolves whether to run. */
export type CostGate = (tabId: string, sql: string, origin: { readonly line: number; readonly column: number }, signal: AbortSignal) => Promise<boolean>
export class QueryService extends SnapshotStore<QuerySnapshot> implements Disposable {
  readonly statistics = new ClientStatisticsService()
  private disposed = false
  /** Each running execution, so closing its tab can wait for the cancel to land. */
  private readonly runs = new Map<string, Promise<void>>()
  private readonly executionVersions = new Map<string, number>()
  /** Source versions, without SQL text, so an old error never points into a query edited or re-executed since. */
  private readonly sources = new Map<string, { readonly queryId: string; readonly revision: number }>()
  private readonly subscription: Disposable
  /** Each BigQuery query's session location, from its last job: a dataset in another location ends the session (decision 18). */
  private readonly locations = new Map<string, string>()
  /** Shows a note whose query has closed, as a notification. Set once the workbench is built. */
  notify?: (text: string) => void
  /** BigQuery's estimate and cost prompts before a run (BigQueryCostService.beforeExecute); resolves whether to run. */
  private costGate?: CostGate
  /** Runs waiting on the cost gate, which Cancel stops before anything is sent: the tab goes back as it was at once. */
  private readonly gated = new Map<string, { readonly queryId: string; readonly stop: AbortController; readonly before: QueryState | undefined }>()
  /** Each tab's re-attaches tried, by job and connection generation: a job is re-attached once per connection. */
  private readonly attachTried = new Map<string, Map<string, number>>()
  private readonly reattachWaiting = new Set<string>()
  /** Each tab's job key as last seen, so its records go when it closes (the document is gone by then). */
  private readonly jobKeys = new Map<string, string>()
  /** Runs whose job was left running or cancelled by a session end: they keep no job references when they settle. */
  private readonly forgotten = new Set<string>()
  /** Shows that BigQuery jobs were left running, with their ids to copy (no tab follows them any more). Set by the workbench. */
  notifyJobs?: (text: string, jobIds: readonly string[]) => void
  /** BigQuery: the tab's current dry-run estimate in bytes (BigQueryCostService), kept with a run for the job prompt. */
  estimateOf?: (tabId: string) => number | undefined
  constructor(private documents: DocumentService, private api: QueryApi, private getConnection: (id: string) => QueryConnection | undefined, private events: EventBus,
    private results: Pick<ResultsService, 'begin' | 'finish'> & Partial<Pick<ResultsService, 'addMessage'>>, private now: () => number = () => Date.now(), private wait: (ms: number) => Promise<void> = ms => new Promise(resolve => { setTimeout(resolve, ms) }),
    private settings: () => SettingsValues = () => defaultSettings, private retainedPlans?: RetainedPlansService) {
    super({})
    this.subscription = events.subscribe(event => {
      if (event.type === 'session.ended') this.sessionEnded(event.tabId)
      if (event.type === 'documents.closed') {
        // No tab will re-attach to a closed tab's jobs: their records go (a quit keeps them, since it closes no tab).
        const key = this.jobKeys.get(event.tabId)
        this.jobKeys.delete(event.tabId)
        if (key) void this.api.dropJobRecords?.(key).catch(() => {})
        this.attachTried.delete(event.tabId); this.statistics.reset(event.tabId); this.sources.delete(event.tabId); this.executionVersions.delete(event.tabId); this.locations.delete(event.tabId) }
      if (event.type === 'query.outputSelected') {
        const state = this.getSnapshot()[event.tabId]
        if (state?.estimated && state.estimated.view !== event.view)
          this.update(event.tabId, { ...state, estimated: { ...state.estimated, view: event.view } })
      }
    })
  }
  /** The location of a BigQuery query's session, while it has one Varia knows of. */
  sessionLocation(id: string): string | undefined { return this.locations.get(id) }
  /** Appends a line to the query's Messages at once, outside any execution (a messages-only view when no results are open). */
  addSessionMessage(tabId: string, text: string, kind: 'info' | 'error' = 'info'): void {
    if (!this.disposed && this.documents.get(tabId)) this.results.addMessage?.(tabId, text, kind)
  }
  /** Shows a BigQuery close's note: in the query's Messages while it is open, else as a notification naming it (`name`,
   *  since a closed query has none left to read), so a commit that did not happen is never unseen. */
  sessionNote(tabId: string, note: SessionCloseNote, name?: string): void {
    const document = this.documents.get(tabId), text = sessionCloseNoteText(name ?? document?.name ?? 'A query', note)
    if (document) this.addSessionMessage(tabId, text, note.code === 'sessionExpired' ? 'info' : 'error')
    else this.notify?.(text)
  }
  /** Asks decision 18's question before a BigQuery query's dataset moves its session to another location: true for Switch. */
  async confirmLocationSwitch(tabId: string, location: SessionLocationSwitch): Promise<boolean> {
    const document = this.documents.get(tabId)
    if (!document || this.disposed) return false
    const response = await this.api.confirmSessions({ action: 'switchLocation', tabs: [{ name: document.name.slice(0, sessionPromptLimits.name), transactions: 0, running: false, provider: 'bigquery' }], location })
    if (!response.ok) throw new Error(response.error)
    return !this.disposed && response.value === 'proceed'
  }
  setCostGate(gate: CostGate): void { this.costGate = gate }
  /** Stops a run still waiting on its estimate or cost prompt (nothing was sent): the tab is as it was. */
  /** Whether the tab's run is still in its estimate or cost prompt (nothing sent yet). */
  private isGated(tabId: string): boolean { const running = this.getSnapshot()[tabId]?.running; return !!running && this.gated.get(tabId)?.queryId === running.queryId }
  private stopGated(tabId: string, queryId: string): boolean {
    const gated = this.gated.get(tabId)
    if (gated?.queryId !== queryId) return false
    this.gated.delete(tabId)
    gated.stop.abort()
    const current = this.getSnapshot()[tabId]
    if (current?.running?.queryId === queryId) {
      // As it was, but with the session as it is now: one that ended while the run waited stays ended.
      const restored = gated.before ? { ...gated.before, session: current.session } : current.session ? { session: current.session } : undefined
      const next = { ...this.getSnapshot() }
      if (restored) next[tabId] = restored
      else delete next[tabId]
      this.publish(next)
    }
    return true
  }
  isRunning(id: string): boolean { return !!this.getSnapshot()[id]?.running }
  /** The tab's job key, given now when it has none: main records its BigQuery jobs under it. */
  private jobKeyOf(tabId: string): string {
    const key = this.documents.get(tabId)?.jobKey ?? crypto.randomUUID()
    if (!this.documents.get(tabId)?.jobKey) this.documents.update(tabId, { jobKey: key })
    this.jobKeys.set(tabId, key)
    return key
  }
  private attachKey(job: TabJob, connection: QueryConnection): string { return `${job.project}:${job.jobId}@${connection.id}:${connection.generation}` }
  /** query.attach for one of the tab's jobs: it adopts the job's session with the record's transaction state; `follow` false
   *  (an older job than one the tab already has) or a detached job only holds the session's queue and reads no results. */
  private attachRequest(tabId: string, queryId: string, connectionId: string, jobKey: string, job: TabJob,
    options: { maxRows: number; maxResultSets: number; residence?: 'automatic' | 'memory' | 'windowed'; windowCacheMiB?: number; prices?: boolean }, follow: boolean) {
    return this.api.attach!({
      connectionId, sessionId: tabId, queryId, jobKey, jobId: job.jobId, project: job.project, ...job.location ? { location: job.location } : {},
      maxRows: options.maxRows, maxResultSets: Math.max(1, options.maxResultSets), adoptSession: true, transaction: job.transaction,
      ...job.detached || !follow ? { detached: true } : {}, ...options.residence ? { residence: options.residence } : {},
      ...options.windowCacheMiB ? { windowCacheMiB: options.windowCacheMiB } : {}, ...options.prices === false ? { prices: false } : {}
    })
  }
  /**
   * A restored BigQuery tab's jobs (hot exit, Reload Window, AutoRecover): held until its connection is live, then
   * re-attached. A running job of a tab that cannot connect now says so in its Messages, so it is never unseen.
   */
  restoreJobs(tabId: string, jobs: readonly TabJob[]): void {
    if (this.disposed || !this.documents.get(tabId) || !jobs.length) return
    const key = this.documents.get(tabId)?.jobKey
    if (key) this.jobKeys.set(tabId, key)
    const state = this.getSnapshot()[tabId], known = new Set(state?.jobs?.map(job => job.jobId))
    this.update(tabId, { ...state, jobs: [...state?.jobs ?? [], ...jobs.filter(job => !known.has(job.jobId))] })
    const running = jobs.filter(job => job.state === 'running' && !job.detached)
    // Only a tab that will not reconnect by itself is told to Reconnect: one that will re-attaches as it connects.
    const document = this.documents.get(tabId)
    if (running.length && !this.connected(tabId) && !(isQueryDocument(document) && document?.attachWanted)) this.addSessionMessage(tabId, restoredJobRunning(running.map(job => job.jobId)))
    this.reattach()
  }
  /**
   * Re-attaches each tab holding jobs it does not follow, once its BigQuery connection is live and it runs nothing: the
   * newest job, which opens its results; older ones stay as references (finished ones are dropped). Each job is tried once per
   * connection generation, so a failed re-attach waits for the next connect. The workbench calls this when connections
   * or tabs change; a run that keeps jobs calls it as it ends.
   */
  reattach(): void {
    if (this.disposed || !this.api.attach) return
    for (const [tabId, state] of Object.entries(this.getSnapshot())) {
      if (!state.jobs?.length || state.running) continue
      // A run that just ended is still settling: look again once it has.
      const settling = this.runs.get(tabId)
      if (settling) { if (!this.reattachWaiting.has(tabId)) { this.reattachWaiting.add(tabId); void settling.finally(() => { this.reattachWaiting.delete(tabId); this.reattach() }) } continue }
      if (!this.canExecute(tabId)) continue
      const document = this.documents.get(tabId), connection = document?.connectionId ? this.getConnection(document.connectionId) : undefined
      if (!connection || connection.providerId !== 'bigquery' || !isQueryDocument(document)) continue
      const tried = this.attachTried.get(tabId) ?? new Map<string, number>()
      const job = [...state.jobs].reverse().find(candidate => !tried.has(this.attachKey(candidate, connection)))
      if (!job) continue
      // Only the newest job is re-attached: an attach releases the tab's results, so an older one would replace the newest's.
      // Older finished jobs are dropped; older running ones (in another session, since a session runs one job at a time)
      // stay with the tab as references its prompt asks about, cancelled from their records (session.cancelRestoredJobs).
      const generation = `@${connection.id}:${connection.generation}`
      if ([...tried].some(([key, createdAt]) => key.endsWith(generation) && createdAt > job.createdAt)) {
        const older = state.jobs.filter(candidate => !tried.has(this.attachKey(candidate, connection)))
        for (const candidate of older) tried.set(this.attachKey(candidate, connection), candidate.createdAt)
        this.attachTried.set(tabId, tried)
        const kept = state.jobs.filter(candidate => !older.includes(candidate) || candidate.state === 'running')
        if (kept.length !== state.jobs.length) { const { jobs: _jobs, ...rest } = state; this.update(tabId, kept.length ? { ...rest, jobs: kept } : rest) }
        continue
      }
      const follow = true
      tried.set(this.attachKey(job, connection), job.createdAt)
      this.attachTried.set(tabId, tried)
      this.executionVersions.set(tabId, (this.executionVersions.get(tabId) ?? 0) + 1)
      const run = this.run(tabId, undefined, job, follow)
      this.runs.set(tabId, run)
      void run.finally(() => { if (this.runs.get(tabId) === run) this.runs.delete(tabId) })
    }
  }
  /** Idle BigQuery sessions whose end failed: a notification, since their tabs may be gone. */
  failedAborts(count: number): void { if (!this.disposed && count > 0) this.notify?.(failedAbortsText(count)) }
  /** The ids of the BigQuery jobs the tab holds: its running request's, then those it holds without following. */
  private heldJobIds(tabId: string): string[] {
    const state = this.getSnapshot()[tabId]
    return [...new Set([...state?.running?.jobId ? [state.running.jobId] : [], ...state?.jobs?.map(job => job.jobId) ?? []])]
  }
  /**
   * A query's session ended as the prompt planned (DocumentService.endSession). A job left running is no tab's any more:
   * the tab forgets it, its records go, and a notification shows its id to copy. A cancelled job is forgotten too.
   */
  sessionClosed(tabId: string, entry: SessionPlanEntry | undefined): void {
    if (this.disposed || (entry !== 'leave' && entry !== 'cancelJob')) return
    const ids = this.heldJobIds(tabId), state = this.getSnapshot()[tabId]
    const running = !!state?.running && state.running.kind !== 'estimate'
    if (running) this.forgotten.add(state!.running!.queryId)
    if (state?.jobs) { const { jobs: _jobs, ...rest } = state; this.update(tabId, rest) }
    const key = this.documents.get(tabId)?.jobKey ?? this.jobKeys.get(tabId)
    const name = this.documents.get(tabId)?.name ?? 'A query'
    // Jobs the tab holds without running them (a restored tab not connected, or an older job not re-attached): the
    // backend's session knows none of them, so main cancels them from their records first. A job left running on a
    // connected tab is the session's own, which the backend cancels with the session; so is the running request's.
    const connected = this.connected(tabId)
    const targets = (state?.jobs ?? []).filter(job => job.jobId !== state?.running?.jobId && (!connected || !job.detached)).map(job => job.jobId)
    if (entry === 'cancelJob' && targets.length && key && this.api.cancelRestoredJobs) {
      void this.cancelRestored(name, key, targets)
      return
    }
    if (key) void this.api.dropJobRecords?.(key).catch(() => {})
    if (entry === 'leave' && ids.length) {
      const name = this.documents.get(tabId)?.name ?? 'A query'
      this.notifyJobs?.(`${name}: ${ids.length === 1 ? `BigQuery job ${ids[0]} was` : `BigQuery jobs ${ids.join(', ')} were`} left running. Find ${ids.length === 1 ? 'it' : 'them'} in BigQuery's job history.`, ids)
    }
  }
  /** Cancels a tab's recorded jobs through main, then forgets its records; what could not be cancelled is shown by id. */
  private async cancelRestored(name: string, key: string, targets: readonly string[]): Promise<void> {
    let failed: string[]
    try {
      const response = await this.api.cancelRestoredJobs!([key])
      // Main cancels every running record under the key; only the jobs the backend did not cancel itself are reported.
      failed = response.ok ? [...response.value.uncancellable, ...response.value.jobs.filter(job => !job.cancelled).map(job => job.jobId)].filter(id => targets.includes(id)) : []
      if (!response.ok) this.notify?.(`${name}: its BigQuery jobs could not be cancelled. ${response.error}`)
    } catch { failed = [] }
    await this.api.dropJobRecords?.(key).catch(() => {})
    if (failed.length && !this.disposed) this.notifyJobs?.(`${name}: ${failed.length === 1 ? `BigQuery job ${failed[0]} could not be cancelled` : `BigQuery jobs ${failed.join(', ')} could not be cancelled`}. Cancel ${failed.length === 1 ? 'it' : 'them'} in BigQuery's job history.`, failed)
  }
  /**
   * After a restore: running jobs no open tab (or AutoRecover copy) will re-attach to are asked about once, in main's box.
   * The outcome's failures are shown by id to copy.
   */
  async reviewJobsWithoutTab(api: Partial<Pick<VariaApi, 'reviewJobsWithoutTab'>>): Promise<void> {
    if (this.disposed || !api.reviewJobsWithoutTab) return
    const keys = [...new Set(this.documents.getSnapshot().documents.flatMap(document => isQueryDocument(document) && document.jobKey ? [document.jobKey] : []))]
    let review
    try { const response = await api.reviewJobsWithoutTab(keys); if (!response.ok) return; review = response.value } catch { return }
    if (!review || review.answer !== 'cancel' || !review.cancel || this.disposed) return
    const failed = [...review.cancel.uncancellable, ...review.cancel.jobs.filter(job => !job.cancelled).map(job => job.jobId)]
    if (failed.length) this.notifyJobs?.(`${failed.length === 1 ? `BigQuery job ${failed[0]} could not be cancelled` : `BigQuery jobs ${failed.join(', ')} could not be cancelled`}. Cancel ${failed.length === 1 ? 'it' : 'them'} in BigQuery's job history.`, failed)
  }
  /**
   * Whether the tab holds a BigQuery job (docs/bigquery.md, The prompt): its query or re-attach runs, it holds job references
   * not yet attached, or a detached job the backend still sees running (`query.session.state`'s `job`, read now). A read that
   * fails falls back to the tab's own references, so such a tab is asked about its job.
   */
  async holdsJob(id: string): Promise<boolean> {
    const document = this.documents.get(id), connection = document?.connectionId ? this.getConnection(document.connectionId) : undefined
    if (!isQueryDocument(document) || (connection ? connection.providerId !== 'bigquery' : document?.provider !== 'bigquery')) return false
    const state = this.getSnapshot()[id]
    // A run still in its estimate or cost prompt sent nothing: the prompt stops it like any query.
    if (state?.running && state.running.kind !== 'estimate' && !this.isGated(id)) return true
    const jobs = state?.jobs ?? []
    if (!jobs.length) return false
    if (jobs.some(job => !job.detached) || !this.connected(id)) return true
    try {
      const response = await this.api.querySessionState(id)
      if (!response.ok || response.value.job === undefined) return true
      if (response.value.job === 'running') return true
      // The backend saw the detached jobs end: nothing is held any more.
      const current = this.getSnapshot()[id]
      if (current?.jobs?.length) {
        const { jobs: _jobs, ...rest } = current, kept = current.jobs.filter(job => !job.detached)
        this.update(id, kept.length ? { ...rest, jobs: kept } : rest)
      }
      return !!this.getSnapshot()[id]?.jobs?.length
    } catch { return true }
  }
  isConnectionRunning(id: string): boolean { return Object.values(this.getSnapshot()).some(state => state.running?.connectionId === id) }
  /** A location from this exact execution while the submitted document is still unchanged. */
  sourceLine(tabId: string, queryId: string, line: number | undefined): number | undefined {
    const source = this.sources.get(tabId), model = this.documents.getModel(tabId)
    return source?.queryId === queryId && model && source.revision === model.getVersionId() && Number.isSafeInteger(line) && line! > 0 && line! <= model.getLineCount() ? line : undefined
  }
  canExecute(id = this.documents.getSnapshot().activeId): boolean {
    const document = this.documents.get(id)
    const connection = document?.connectionId ? this.getConnection(document.connectionId) : undefined
    return !this.disposed && !this.documents.getSnapshot().busy && isLiveConnection(connection) && !this.isRunning(id)
  }
  /**
   * Reads the open transaction of an idle query's session from the backend (query.session.state), as SSMS asks its
   * session when a query window closes or disconnects. A query without a live connection, or whose session is gone (never
   * opened, closed, lost, or ended with the backend), has nothing open; a lost one makes the query's next execution say
   * that it runs in a new session, since the user may keep the query. Anything else that keeps the count from being read
   * (SET options that keep the SELECT from executing, a session still busy, no answer in time) may hold one.
   */
  async transactionState(id: string): Promise<TransactionState> {
    if (!this.connected(id)) return nothingOpen
    try {
      const response = await this.api.querySessionState(id)
      if (response.ok) return response.value.checked ? { transactions: response.value.transactionCount } : mayBeOpen
      if (!sessionGone.has(response.code)) return mayBeOpen
      if (response.code === 'SESSION_LOST' || response.code === 'SESSION_CLOSED') this.sessionEnded(id)
      if (response.code === 'SESSION_LOST' && this.documents.get(id) && !this.documents.get(id)?.sessionNotice) this.documents.update(id, { sessionNotice: 'lost' })
      return nothingOpen
    } catch { return mayBeOpen }
  }
  /** Teardown may still need to inspect an existing session while its connection is disconnecting. */
  private connected(id: string): boolean {
    // Only a query has a session: a table designer's connection is not one to read.
    const document = this.documents.get(id), connectionId = isQueryDocument(document) ? document?.connectionId : undefined, connection = connectionId ? this.getConnection(connectionId) : undefined
    return !this.disposed && !!connection && !connection.lost
  }
  /**
   * The names of this window's queries on `connectionId` in `database` that are running or may hold an open transaction,
   * read from their sessions a few at a time within `stateBudgetMs` (one not read by then may hold one), for a prompt that
   * closes the database's connections and so rolls them back (critic A7). Names compare without case.
   */
  async transactionTabs(connectionId: string, database: string): Promise<string[]> {
    const wanted = database.toLowerCase()
    const tabs = this.documents.getSnapshot().documents.filter(document => isQueryDocument(document) && document.connectionId === connectionId && document.database.toLowerCase() === wanted)
      .map(document => ({ id: document.id, name: document.name, open: this.isRunning(document.id) || this.connected(document.id) }))
    const reads = tabs.filter(tab => tab.open && !this.isRunning(tab.id))
    if (reads.length) {
      let expired = false
      const reading = (async () => {
        for (let next = 0; next < reads.length && !expired; next += sessionRequests)
          await Promise.all(reads.slice(next, next + sessionRequests).map(async tab => { const state = await this.transactionState(tab.id); if (!expired) tab.open = state.transactions > 0 || !!state.unchecked }))
      })()
      await Promise.race([reading, this.wait(stateBudgetMs)])
      expired = true
    }
    return tabs.filter(tab => tab.open).map(tab => tab.name)
  }
  /**
   * The names of the open query tabs among `ids`, in tab order. A query's session id is its tab's id, so the backend, which sees
   * each session's transactions on the server, says which tabs hold one in a database (A7: Delete Object names them), whatever
   * database the tab is in.
   */
  tabNames(ids: readonly string[]): string[] {
    const wanted = new Set(ids)
    return this.documents.getSnapshot().documents.filter(document => isQueryDocument(document) && wanted.has(document.id)).map(document => document.name)
  }
  /** Whether the idle query's session may hold a transaction (read now, as transactionState does). */
  async mayHaveTransaction(id: string): Promise<boolean> {
    const state = await this.transactionState(id)
    return state.transactions > 0 || !!state.unchecked
  }
  private update(id: string, state: QueryState): void { this.publish({ ...this.getSnapshot(), [id]: state }) }
  forget(id: string): void {
    this.sources.delete(id)
    this.executionVersions.delete(id)
    if (!this.getSnapshot()[id]) return
    const next = { ...this.getSnapshot() }; delete next[id]; this.publish(next)
  }
  /** The tab's session ended (closed, or lost), and its transaction with it. */
  sessionEnded(id: string): void {
    this.statistics.sessionEnded(id)
    this.locations.delete(id)
    const state = this.getSnapshot()[id]
    if (state?.session) this.update(id, { ...state, session: undefined })
  }
  /** What Tools › Options and the connection's Advanced properties ask of an execution; `stopOnError` only when on. Rows
   *  are bounded by the backend's memory budget, and by Options' limit on rows kept when one is set (0 is none); with
   *  Discard results after execution none are kept. */
  private executionOptions(connection: QueryConnection) {
    const settings = this.settings()
    return {
      maxRows: settings['queryResults.grid.maxRows'], maxResultSets: settings['queryResults.grid.maxResultSets'],
      timeoutSeconds: connection.options?.advanced?.commandTimeout ?? settings['queryExecution.executionTimeout'],
      // Stop on error is SQL Server's (GO batches); a BigQuery query is one job, and main refuses the option for it.
      ...settings['queryExecution.stopOnError'] && connection.providerId !== 'bigquery' ? { stopOnError: true } : {},
      ...settings['queryResults.grid.discardResults'] ? { discardResults: true } : {},
      // BigQuery: Options' cap goes with every job when the connection sets none (the backend prefers the connection's),
      // and Bytes only leaves the dollars out of Messages.
      ...connection.providerId === 'bigquery' && settings['queryExecution.bigQuery.maximumBytesBilled'] > 0 ? { maximumBytesBilled: settings['queryExecution.bigQuery.maximumBytesBilled'] * 2 ** 30 } : {},
      ...connection.providerId === 'bigquery' && settings['queryExecution.bigQuery.showCost'] === 'bytes' ? { prices: false } : {},
      // BigQuery: where results live and each windowed result's block cache (docs/bigquery.md, Residence); SQL Server refuses both.
      ...connection.providerId === 'bigquery' ? { residence: settings['queryResults.bigQuery.residence'], windowCacheMiB: settings['queryResults.bigQuery.windowCacheMiB'] } : {}
    }
  }
  private planContext(tabId: string, executionId: string, sql: string, startLine: number, startedAt: number, estimateMode?: EstimatedPlanMode, sqlScope?: 'document' | 'selection'): PlanExecutionContext {
    const document = this.documents.get(tabId)!, connection = this.getConnection(document.connectionId!)
    return Object.freeze({ executionId, tabId, name: document.name, file: document.file?.path,
      connectionId: document.connectionId!, server: connection?.server, database: document.database,
      sql, startLine, sqlScope: sqlScope ?? (sql === this.documents.getModel(tabId)?.getValue() ? 'document' : 'selection'), startedAt,
      includeActualPlan: !estimateMode && !!document.includeActualPlan, includeLivePlan: !estimateMode && !!document.includeLivePlan,
      ...estimateMode ? { estimateMode } : {} })
  }
  /** Runs the active query, or the query `tabId` names. `preview`: a BigQuery tab's Preview Rows, read with tabledata.list
   *  (free, no job, so no cost prompt) instead of running the text, which is the SELECT it stands for. */
  execute(tabId = this.documents.getSnapshot().activeId, preview?: BigQueryPreviewTarget): Promise<void> {
    if (!this.canExecute(tabId)) return Promise.resolve()
    this.executionVersions.set(tabId, (this.executionVersions.get(tabId) ?? 0) + 1)
    const run = this.run(tabId, preview)
    this.runs.set(tabId, run)
    return run.finally(() => { if (this.runs.get(tabId) === run) this.runs.delete(tabId) })
  }
  /** Shares only the tab's busy/cancel lifecycle. Estimates neither begin result streaming nor replace stored grids. */
  estimate(tabId = this.documents.getSnapshot().activeId, mode: EstimatedPlanMode = 'isolated'): Promise<void> {
    if (!this.canExecute(tabId) || !isQueryDocument(this.documents.get(tabId))) return Promise.resolve()
    this.executionVersions.set(tabId, (this.executionVersions.get(tabId) ?? 0) + 1)
    const run = this.runEstimate(tabId, mode)
    this.runs.set(tabId, run)
    return run.finally(() => { if (this.runs.get(tabId) === run) this.runs.delete(tabId) })
  }
  private async runEstimate(tabId: string, mode: EstimatedPlanMode): Promise<void> {
    const document = this.documents.get(tabId)!, connectionId = document.connectionId!
    const { sql, startLine } = this.documents.getExecuteText(tabId)
    if (!sql.trim()) return
    const requestId = crypto.randomUUID(), previous = this.getSnapshot()[tabId]
    const planContext = this.retainedPlans ? this.planContext(tabId, requestId, sql, startLine, this.now(), mode) : undefined
    this.update(tabId, { ...previous, running: { queryId: requestId, connectionId, startedAt: this.now(), kind: 'estimate', estimateMode: mode }, estimated: { requestId, mode, loading: true, view: 'plan' } })
    this.events.emit({ type: 'query.estimateStarted', tabId })
    let result: EstimatedPlanResult | undefined, error: string | undefined, code: ErrorCode | undefined
    try {
      if (!this.api.estimatePlan) throw new Error('This SQL backend does not support estimated execution plans.')
      const response = await this.api.estimatePlan({ connectionId, sessionId: tabId, database: document.database, sql, startLine, requestId, ...mode === 'session' ? { mode } : {} })
      if (response.ok) result = response.value
      else { error = response.error; code = response.code }
    } catch (failure) { error = errorText(failure) }
    if (this.disposed || !this.documents.get(tabId) || this.getSnapshot()[tabId]?.running?.queryId !== requestId) return
    if (mode === 'session' && sessionGone.has(code)) {
      this.sessionEnded(tabId)
      if (code === 'SESSION_LOST') this.documents.update(tabId, { sessionNotice: 'lost' })
    }
    if (result && planContext && this.retainedPlans) {
      await this.retainedPlans.capture(planContext, { status: 'completed', endedAt: this.now(), database: result.database,
        spid: result.session?.spid, login: result.session?.login }, result.plans.map((plan, index) => ({
        key: `${requestId}:${index}`, label: `Estimated plan ${index + 1}`, captureType: 'estimated',
        batchNumber: plan.batchNumber, iteration: plan.iteration, read: async () => ({ text: plan.xml })
      })))
      if (this.disposed || !this.documents.get(tabId) || this.getSnapshot()[tabId]?.running?.queryId !== requestId) return
    }
    if (mode === 'session' && result?.session && this.documents.get(tabId)?.connectionId === connectionId && this.connected(tabId)) {
      this.update(tabId, { ...this.getSnapshot()[tabId], session: { connectionId, ...result.session } })
    }
    const next = { ...this.getSnapshot(), [tabId]: { ...this.getSnapshot()[tabId], running: undefined, estimated: { requestId, mode, result, error, view: this.getSnapshot()[tabId].estimated?.view } } }
    const size = (state: QueryState) => state.estimated?.result?.plans.reduce((sum, plan) => sum + plan.xml.length, 0) ?? 0
    let characters = Object.values(next).reduce((sum, state) => sum + size(state), 0)
    for (const [id, state] of Object.entries(next)) {
      if (characters <= estimatedPlanCacheCharacters) break
      if (id === tabId || !state.estimated?.result) continue
      characters -= size(state)
      next[id] = { ...state, estimated: { requestId: state.estimated.requestId, mode: state.estimated.mode, view: state.estimated.view, error: 'This estimated plan was released to limit memory. Display Estimated Execution Plan again to reload it.' } }
    }
    this.publish(next)
  }
  /** Runs the tab's text, or re-attaches it to one of its BigQuery jobs (`attach`, query.attach): the same lifecycle, events
   *  and results, without the text, its cost gate or plans. */
  private async run(tabId: string, preview?: BigQueryPreviewTarget, attach?: TabJob, follow = true): Promise<void> {
    const document = this.documents.get(tabId)!
    const connection = this.getConnection(document.connectionId!)!
    if ((preview || attach) && connection.providerId !== 'bigquery') return
    const { sql, startLine, startColumn } = attach ? { sql: '', startLine: 1, startColumn: 1 } : this.documents.getExecuteText(tabId)
    if (!attach && !sql.trim()) return
    const queryId = crypto.randomUUID(), before = this.getSnapshot()[tabId], previous = before?.session
    const provenance: QueryProvenance = Object.freeze({ queryId, connectionId: connection.id, generation: connection.generation, database: document.database, ...connection.targetId ? { targetId: connection.targetId } : {} })
    // A BigQuery query has no SQL Server options (plans, client statistics) and takes the tab's dataset, not a database.
    const bigQuery = connection.providerId === 'bigquery'
    const sqlServerOnly: { includeActualPlan?: boolean; includeLivePlan?: boolean; includeClientStatistics?: boolean } = bigQuery ? {} : document
    // Reserve before the first await so repeated commands cannot start a second script.
    const livePlan = sqlServerOnly.includeLivePlan ? { queryId, connectionId: connection.id } : undefined
    // A BigQuery query's job key, given at its first execution: main records its jobs under it (Re-attaching to jobs).
    const jobKey = bigQuery ? this.jobKeyOf(tabId) : undefined
    // The jobs the tab holds without following them stay held while this runs (the backend waits behind a detached one);
    // a re-attach takes its own job over.
    const held = before?.jobs?.filter(job => job.jobId !== attach?.jobId)
    const reported = new Map<string, TabJob>()
    const estimateBytes = bigQuery && !attach && !preview ? this.estimateOf?.(tabId) : undefined
    this.update(tabId, { running: { queryId, connectionId: connection.id, startedAt: this.now(), ...attach ? { kind: 'attach' as const, jobId: attach.jobId } : {}, ...estimateBytes !== undefined ? { estimateBytes } : {} }, session: previous, provenance, ...livePlan ? { livePlan } : {}, ...held?.length ? { jobs: held } : {} })
    // The text's version and scope as sent, read before the gate: an edit while it waits must not make the run's error
    // locations point into the edited text.
    const revision = this.documents.revision(tabId), sqlScope = sql === this.documents.getModel(tabId)?.getValue() ? 'document' as const : 'selection' as const
    // BigQuery dry-runs first (free) and may ask (docs/bigquery.md, Cost). Declined or cancelled, the tab is as it was.
    if (bigQuery && this.costGate && !preview && !attach) {
      const stop = new AbortController()
      this.gated.set(tabId, { queryId, stop, before })
      const stopped = new Promise<false>(resolve => { stop.signal.addEventListener('abort', () => resolve(false), { once: true }) })
      let run = false
      try { run = await Promise.race([this.costGate(tabId, sql, { line: startLine, column: startColumn }, stop.signal), stopped]) } catch { run = true }
      if (stop.signal.aborted || this.disposed || this.getSnapshot()[tabId]?.running?.queryId !== queryId) {
        if (this.gated.get(tabId)?.queryId === queryId) this.gated.delete(tabId)
        return
      }
      if (!run) { this.stopGated(tabId, queryId); return }
      this.gated.delete(tabId)
    }
    if (!attach) this.sources.set(tabId, { queryId, revision })
    const planContext = this.retainedPlans && !attach ? this.planContext(tabId, queryId, sql, startLine, this.now(), undefined, sqlScope) : undefined
    if (sqlServerOnly.includeClientStatistics) this.statistics.begin(tabId, queryId, connection.id, document.database, !!(document.includeActualPlan || document.includeLivePlan), connection.server, !!document.includeLivePlan)
    let summary: QueryResult | undefined, error: string | undefined, code: ErrorCode | undefined
    try {
      // The options are read once, so the Results view's discard notice describes what this run was asked.
      const options = this.executionOptions(connection)
      // The run's events are followed before the script is sent, so no early result set is missed.
      this.results.begin(tabId, queryId, ({ spid, login }) => {
        const state = this.getSnapshot()[tabId]
        if (state?.running?.queryId === queryId && this.documents.get(tabId)?.connectionId === connection.id && this.connected(tabId))
          this.update(tabId, { ...state, session: { connectionId: connection.id, spid, login } })
      }, { discard: options.discardResults === true, ...bigQuery ? { onJob: (job: Extract<QueryEvent, { type: 'query.job' }>) => {
        const state = this.getSnapshot()[tabId]
        if (state?.running?.queryId === queryId && !state.running.jobId) this.update(tabId, { ...state, running: { ...state.running, jobId: job.jobId } })
        reported.set(job.jobId, { jobId: job.jobId, project: job.project, ...job.location ? { location: job.location } : {}, state: job.state, transaction: job.transaction, createdAt: reported.get(job.jobId)?.createdAt ?? this.now() }) } } : {} })
      this.events.emit({ type: 'query.started', tabId, queryId })
      const target = !bigQuery ? { database: document.database } : /^\w{1,1024}$/.test(document.database) ? { dataset: document.database } : {}
      // A BigQuery error names a column too, so a selection's first column maps it back to the editor.
      const response = attach ? await this.attachRequest(tabId, queryId, connection.id, jobKey!, attach, options, follow)
        : await this.api.execute({ connectionId: connection.id, sessionId: tabId, ...target, sql, startLine, ...bigQuery && startColumn > 1 ? { startColumn } : {}, queryId, ...jobKey ? { jobKey } : {},
        ...options, ...sqlServerOnly.includeActualPlan ? { includeActualPlan: true } : {},
        ...sqlServerOnly.includeClientStatistics ? { includeClientStatistics: true } : {}, ...sqlServerOnly.includeLivePlan ? { includeLivePlan: true } : {}, ...preview ? { preview } : {} })
      if (response.ok) summary = response.value
      else { error = response.error; code = response.code }
    } catch (failure) { error = errorText(failure) }
    if (this.disposed) return
    this.statistics.finish(tabId, queryId, summary)
    if (sessionGone.has(code) || summary && summary.spid === undefined) this.statistics.sessionEnded(tabId)
    // A run that settles after its tab closed (a cancel that took longer than cancelSettleMs) still frees its results.
    if (!this.documents.get(tabId)) { this.forgotten.delete(queryId); this.results.finish(tabId, queryId, { summary, error, code }); return }
    if (this.getSnapshot()[tabId]?.running?.queryId !== queryId) { this.forgotten.delete(queryId); return }
    if (summary?.database) this.documents.update(tabId, { database: summary.database })
    if (bigQuery && summary?.job?.location) this.locations.set(tabId, summary.job.location)
    // A summary means the backend ran the script in a session; the first one after a reconnect is a new session.
    let notice: string | undefined
    const reason = this.documents.get(tabId)?.sessionNotice
    if (summary && reason) {
      notice = bigQuery && reason === 'lost' ? bigQueryLostSessionMessage : noticeMessages[reason]
      this.documents.update(tabId, { sessionNotice: undefined })
    }
    // A summary carries the session's SPID and login while it is open (none when it was lost or never opened); a failure
    // that left no session ends it, and any other failure leaves the session as it was.
    const session: QuerySession | undefined = summary ? summary.spid === undefined ? undefined : { connectionId: connection.id, spid: summary.spid, login: summary.login }
      : sessionGone.has(code) ? undefined : this.getSnapshot()[tabId]?.session
    // A new backend execution releases this session's old results. Keep Execute reserved until original XML is copied.
    await this.results.finish(tabId, queryId, { summary, error, code, notice, ...planContext ? { planContext } : {} })
    if (this.disposed || !this.documents.get(tabId) || this.getSnapshot()[tabId]?.running?.queryId !== queryId) return
    // Backend/connection loss can arrive while XML is copied; never restore that execution's now-dead session.
    const liveSession = this.documents.get(tabId)?.connectionId === connection.id && this.connected(tabId) ? session : undefined
    const jobs = this.forgotten.delete(queryId) ? [] : heldAfter(attach, held, [...reported.values()], summary, code)
    this.update(tabId, { summary, error, session: liveSession, provenance, ...livePlan ? { livePlan } : {}, ...jobs.length ? { jobs } : {} })
    // A job that carries on in BigQuery is never unseen: the tab says so, and re-attaches once its connection is back.
    const lost = jobs.filter(job => !job.detached && job.state === 'running' && !held?.includes(job))
    if (lost.length) this.addSessionMessage(tabId, jobStillRunning(lost.map(job => job.jobId)), 'info')
    // A job left running is followed by this backend already: it is re-attached only after a restart.
    if (summary?.status === 'detached') {
      const tried = this.attachTried.get(tabId) ?? new Map<string, number>()
      for (const job of jobs) tried.set(this.attachKey(job, connection), job.createdAt)
      this.attachTried.set(tabId, tried)
    }
    if (jobs.length) this.reattach()
    this.events.emit({ type: 'query.finished', tabId, queryId, summary, error })
  }
  /** Whether Close Results may ask about the tab's run: a BigQuery job it runs or follows (not an estimate or cost prompt). */
  canCloseRunningJob(tabId: string): boolean {
    const running = this.getSnapshot()[tabId]?.running
    return !!running && running.kind !== 'estimate' && running.jobId !== undefined && !!this.api.confirmRunningJob && !this.disposed
  }
  /**
   * Close Results while a BigQuery job runs (docs/bigquery.md): asks Cancel the job, Leave it running or Don't Close. Cancel
   * stops the run as Stop does; Leave sends query.cancel with `detach`, so the run answers `detached` and the tab keeps the
   * job (holdsJob). Resolves, once the run settled, to whether the results may close.
   */
  async closeRunningJob(tabId: string): Promise<boolean> {
    const running = this.getSnapshot()[tabId]?.running
    if (!running || !this.canCloseRunningJob(tabId)) return false
    const name = this.documents.get(tabId)?.name ?? 'Query'
    let answer
    try {
      const response = await this.api.confirmRunningJob!({ name: name.slice(0, sessionPromptLimits.name), job: { elapsedMs: Math.max(0, this.now() - running.startedAt), ...running.estimateBytes !== undefined ? { estimateBytes: running.estimateBytes } : {}, jobIds: this.heldJobIds(tabId).slice(0, sessionPromptLimits.jobIds) } })
      if (!response.ok) throw new Error(response.error)
      answer = response.value
    } catch (error) { this.notify?.(`Close Results: ${errorText(error)}`); return false }
    // The run may have finished while the box was open: its results close as usual.
    const current = this.getSnapshot()[tabId]?.running
    if (answer === 'cancel' || this.disposed) return false
    if (current?.queryId === running.queryId) {
      if (answer === 'proceed') await this.cancel(tabId)
      else {
        try {
          const response = await this.api.cancel(running.queryId, { detach: true })
          if (!response.ok) throw new Error(response.error)
        } catch (error) { this.notify?.(`Close Results: the job could not be left running. ${errorText(error)}`); return false }
      }
    }
    await this.runs.get(tabId)?.catch(() => {})
    return !this.disposed
  }
  /** Cancels the active query, or the one running in `tabId`. */
  async cancel(tabId = this.documents.getSnapshot().activeId): Promise<void> {
    const running = this.getSnapshot()[tabId]?.running
    if (!running || this.disposed) return
    // Still waiting on its estimate or cost prompt: nothing was sent, so stopping it is local.
    if (this.stopGated(tabId, running.queryId)) return
    try {
      const response = await this.api.cancel(running.queryId)
      if (!response.ok) throw new Error(response.error)
    } catch (error) {
      const state = this.getSnapshot()[tabId]
      if (!this.disposed && state?.running?.queryId === running.queryId) this.update(tabId, { ...state, error: errorText(error) })
    }
    // A cancel acknowledgement is not completion; keep running until execute settles.
  }
  /**
   * Before sessions end (`action`), reads the open transaction of each idle query among `tabIds` from its session (a few
   * at a time, within `stateBudgetMs` in all), then asks in main's message box: first whether to cancel the executing
   * queries (Keep Running is the default), then about the open transactions (Yes, commit, is the default), as SSMS asks
   * each window. It then cancels the running queries (a few at a time) and waits (up to 15 s) for them to stop. Resolves
   * to how each session ends, or to undefined when the user chose Cancel or Keep Running; with nothing to ask, to an empty
   * plan. An executing query is never committed: the prompt says that what it left open is rolled back.
   */
  async confirmSessions(action: SessionAction, tabIds: readonly string[]): Promise<SessionPlan | undefined> {
    const prepared = await this.prepareSessions(action, tabIds)
    if (!prepared) return undefined
    await this.cancelPreparedSessions(prepared, false)
    return prepared.plan
  }
  /** Read and ask only: a later cancelled save or prompt cannot have already cancelled another tab's execution. */
  async prepareSessions(action: SessionAction, tabIds: readonly string[]): Promise<PreparedSessions | undefined> {
    const candidates = tabIds.flatMap(id => {
      const document = this.documents.get(id), operation = this.getSnapshot()[id]?.running
      const estimating = operation?.kind === 'estimate' && operation.estimateMode !== 'session', running = !!operation && !estimating
      // A session not read in time may hold a transaction; a query with no live connection has none to read.
      // An isolated estimate leaves the ordinary session idle: ask about its transaction before cancelling the estimate.
      const connection = document?.connectionId ? this.getConnection(document.connectionId) : undefined
      // A BigQuery query holding a job is asked only about it, in the first box (docs/bigquery.md, The prompt): its query
      // runs, or it holds jobs it does not follow, which holdsJob confirms below.
      const bigQuery = connection ? connection.providerId === 'bigquery' : isQueryDocument(document) && document?.provider === 'bigquery'
      const holding = bigQuery && (running || !!this.getSnapshot()[id]?.jobs?.length)
      return document ? [{ id, name: document.name.slice(0, sessionPromptLimits.name), running, estimating, operation, bigQuery, holding, job: undefined as SessionJob | undefined,
        connectionId: document.connectionId, generation: connection?.generation, version: this.executionVersions.get(id),
        state: !running && this.connected(id) ? mayBeOpen : nothingOpen }] : []
    })
    // A detached job is asked about while the backend still sees it running; a read that fails keeps it asked about.
    const holders = candidates.filter(tab => tab.holding)
    if (holders.length) {
      let expired = false
      const reading = Promise.all(holders.map(async tab => { const holds = await this.holdsJob(tab.id); if (!expired) tab.holding = holds }))
      await Promise.race([reading, this.wait(stateBudgetMs)])
      expired = true
      if (this.disposed) return undefined
    }
    for (const tab of candidates.filter(candidate => candidate.holding)) {
      const state = this.getSnapshot()[tab.id], jobIds = this.heldJobIds(tab.id).slice(0, sessionPromptLimits.jobIds)
      // A job it does not run is one left running (detached), or a restored one not re-attached yet.
      const following = tab.running && !!state?.running && !this.isGated(tab.id), estimateBytes = following ? state.running!.estimateBytes : undefined
      tab.job = { elapsedMs: tab.running && tab.operation ? Math.max(0, this.now() - tab.operation.startedAt) : 0, ...following ? {} : state?.jobs?.length && state.jobs.every(job => job.detached) ? { detached: true as const } : { unattached: true as const }, ...estimateBytes !== undefined ? { estimateBytes } : {}, ...jobIds.length ? { jobIds } : {} }
      // Its session is asked about only through its job: Cancel the job rolls a transaction back, Leave it running keeps it.
      tab.state = nothingOpen
    }
    const reads = candidates.filter(tab => tab.state !== nothingOpen)
    if (reads.length) {
      let expired = false
      const reading = (async () => {
        for (let next = 0; next < reads.length && !expired; next += sessionRequests)
          await Promise.all(reads.slice(next, next + sessionRequests).map(async tab => { const state = await this.transactionState(tab.id); if (!expired) tab.state = state }))
      })()
      await Promise.race([reading, this.wait(stateBudgetMs)])
      expired = true
      if (this.disposed) return undefined
    }
    const tabs = candidates.filter(tab => tab.job || tab.running || tab.state.transactions > 0 || tab.state.unchecked)
    if (tabs.length > sessionPromptLimits.tabs) throw new Error('Too many query sessions to review together. Disconnect fewer queries at a time.')
    const estimates = candidates.filter(tab => tab.estimating)
    const running = tabs.filter(tab => tab.running || tab.job), open = tabs.filter(tab => !tab.running && !tab.job)
    const ask = async (asked: typeof tabs) => {
      const response = await this.api.confirmSessions({
        action, tabs: asked.map(tab => ({ name: tab.name, running: tab.running, transactions: tab.running ? 0 : tab.state.transactions, ...!tab.running && tab.state.unchecked ? { unchecked: true as const } : {},
          ...tab.bigQuery ? { provider: 'bigquery' as const } : {}, ...tab.job ? { job: tab.job } : {} }))
      })
      if (!response.ok) throw new Error(response.error)
      return this.disposed ? 'cancel' : response.value
    }
    // The first box: executing queries, and BigQuery jobs (Cancel the job, or Leave it running).
    const first = running.length ? await ask(running) : 'proceed'
    if (first === 'cancel') return undefined
    const answer = open.length ? await ask(open) : 'rollback'
    if (answer === 'cancel') return undefined
    // A BigQuery job is cancelled or left by its session's close (cancelJob, keepJob), never by query.cancel here.
    // A run still in its estimate or cost prompt is stopped even beside held jobs: it sent nothing.
    const stopping = [...running.filter(tab => !tab.job || this.isGated(tab.id)), ...estimates]
    return {
      plan: new Map(tabs.map(tab => [tab.id, tab.job ? first === 'leave' ? 'leave' : 'cancelJob' : !tab.running && answer === 'commit' ? 'commit' : 'rollback'])),
      stopping: stopping.map(tab => ({ id: tab.id, queryId: tab.operation!.queryId })),
      current: () => !this.disposed && candidates.every(tab => {
        const document = this.documents.get(tab.id), connection = tab.connectionId ? this.getConnection(tab.connectionId) : undefined
        return !!document && document.connectionId === tab.connectionId && this.executionVersions.get(tab.id) === tab.version &&
          connection?.generation === tab.generation && !connection?.lost
      })
    }
  }
  /** Strict disconnects stop on a failed cancellation or unknown outcome, retaining every tab and the live root. */
  async cancelPreparedSessions(prepared: PreparedSessions, strict = true): Promise<void> {
    if (strict && !prepared.current()) throw new Error('A query session changed while confirming disconnect. Review the disconnect again.')
    if (!prepared.stopping.length) return
    for (let next = 0; next < prepared.stopping.length; next += sessionRequests) {
      await Promise.all(prepared.stopping.slice(next, next + sessionRequests).map(async tab => {
        if (this.getSnapshot()[tab.id]?.running?.queryId !== tab.queryId) return
        if (!strict) { await this.cancel(tab.id); return }
        if (this.stopGated(tab.id, tab.queryId)) return
        try {
          const response = await this.api.cancel(tab.queryId)
          if (!response.ok) throw new Error(response.error)
        } catch (error) { throw new Error(`Query cancellation failed: ${errorText(error)} The execution outcome may be unknown; no tabs were closed.`) }
      }))
    }
    const stopped = Promise.all(prepared.stopping.map(tab => this.runs.get(tab.id)?.catch(() => {})))
    await Promise.race([stopped, this.wait(cancelSettleMs)])
    if (strict && prepared.stopping.some(tab => this.getSnapshot()[tab.id]?.running?.queryId === tab.queryId))
      throw new Error('A cancelled query has not reported completion. Its outcome may be unknown; no tabs were closed. Review its state before trying again.')
  }
  dispose(): void { this.disposed = true; for (const gated of this.gated.values()) gated.stop.abort(); this.gated.clear(); this.subscription.dispose(); this.statistics.dispose(); this.sources.clear(); this.executionVersions.clear(); this.clearListeners(); this.publish({}) }
}
