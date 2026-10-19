import type { ConnectionInfo, QueryResult, VariaApi } from '../../../shared/contracts'
import type { ErrorCode } from '../../../shared/ipc/wire/protocol'
import { sessionPromptLimits, type SessionAction, type SessionEnd } from '../../../shared/sessions'
import { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResultsService } from '../results/ResultsService'
import { DocumentService } from './documents'

export interface RunningQuery { readonly queryId: string; readonly connectionId: string; readonly startedAt: number }
/** The tab's SQL session as its last execution reported it: its SPID and login, read when it opened (SSMS's status bar
 *  shows them). It belongs to the connection it ran on, so a query moved elsewhere (or a connection lost) no longer has
 *  it. Its open transaction is not kept here: it is read from the session only when the session is about to end. */
export interface QuerySession { readonly connectionId: string; readonly spid?: number; readonly login?: string }
/** A tab's last run: its summary (the rows stay in the backend; ResultsService shows them) or main's failure. */
export interface QueryState { readonly running?: RunningQuery; readonly summary?: QueryResult; readonly error?: string; readonly session?: QuerySession }
export type QueryApi = Pick<VariaApi, 'execute' | 'cancel' | 'confirmSessions' | 'querySessionState'>
export type QuerySnapshot = Readonly<Record<string, QueryState>>
/** How each tab's session ends after the user answered: its open transaction committed or rolled back first. Tabs it does
 *  not name have nothing to end. */
export type SessionPlan = ReadonlyMap<string, SessionEnd>
/** An idle session's open transaction as read just before it ends; `unchecked` means it may hold one. */
export interface TransactionState { readonly transactions: number; readonly unchecked?: true }
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'The operation failed.'
export const newSessionMessage = 'This query opened a new SQL session. The previous session ended when the SQL backend restarted, so its SET options, temporary tables, and open transaction no longer exist.'
type QueryConnection = ConnectionInfo & { readonly lost?: true }
/** Rows are bounded only by the backend's memory budget; up to 1,000 result sets are kept, as SSMS keeps them all. */
export const queryLimits = { maxRows: 0, maxResultSets: 1000 } as const
/** Failures after which the tab has no session, so no open transaction. */
const sessionGone: ReadonlySet<ErrorCode | undefined> = new Set<ErrorCode | undefined>(['SESSION_LOST', 'SESSION_CLOSED', 'NOT_CONNECTED', 'CONNECTION_LOST', 'BACKEND_LOST'])
/** How long ending sessions waits for the queries it cancelled to stop; their sessions close (and roll back) either way. */
export const cancelSettleMs = 15_000
/** Session states read at once before a prompt: each is one short request, and Close All may cover hundreds of tabs. */
export const stateReads = 8
const nothingOpen: TransactionState = { transactions: 0 }
const mayBeOpen: TransactionState = { transactions: 0, unchecked: true }

export class QueryService extends SnapshotStore<QuerySnapshot> implements Disposable {
  private disposed = false
  /** Each running execution, so closing its tab can wait for the cancel to land. */
  private readonly runs = new Map<string, Promise<void>>()
  private readonly subscription: Disposable
  constructor(private documents: DocumentService, private api: QueryApi, private getConnection: (id: string) => QueryConnection | undefined, private events: EventBus,
    private results: Pick<ResultsService, 'begin' | 'finish'>, private now: () => number = () => Date.now(), private wait: (ms: number) => Promise<void> = ms => new Promise(resolve => { setTimeout(resolve, ms) })) {
    super({})
    this.subscription = events.subscribe(event => { if (event.type === 'session.ended') this.sessionEnded(event.tabId) })
  }
  isRunning(id: string): boolean { return !!this.getSnapshot()[id]?.running }
  isConnectionRunning(id: string): boolean { return Object.values(this.getSnapshot()).some(state => state.running?.connectionId === id) }
  canExecute(id = this.documents.getSnapshot().activeId): boolean {
    const document = this.documents.get(id)
    const connection = document?.connectionId ? this.getConnection(document.connectionId) : undefined
    return !this.disposed && !this.documents.getSnapshot().busy && !!connection && !connection.lost && !this.isRunning(id)
  }
  /**
   * Reads the open transaction of an idle query's session from the backend (query.session.state), as SSMS asks its
   * session when a query window closes or disconnects. A query without a live connection, or whose session is gone (never
   * opened, closed, lost, or ended with the backend), has nothing open. Anything else that keeps the count from being read
   * (SET options that keep the SELECT from executing, a session still busy, no answer in time) may hold one.
   */
  async transactionState(id: string): Promise<TransactionState> {
    const connectionId = this.documents.get(id)?.connectionId, connection = connectionId ? this.getConnection(connectionId) : undefined
    if (this.disposed || !connection || connection.lost) return nothingOpen
    try {
      const response = await this.api.querySessionState(id)
      if (response.ok) return response.value.checked ? { transactions: response.value.transactionCount } : mayBeOpen
      if (!sessionGone.has(response.code)) return mayBeOpen
      if (response.code === 'SESSION_LOST' || response.code === 'SESSION_CLOSED') this.sessionEnded(id)
      return nothingOpen
    } catch { return mayBeOpen }
  }
  /** Whether the idle query's session may hold a transaction (read now, as transactionState does). */
  async mayHaveTransaction(id: string): Promise<boolean> {
    const state = await this.transactionState(id)
    return state.transactions > 0 || !!state.unchecked
  }
  private update(id: string, state: QueryState): void { this.publish({ ...this.getSnapshot(), [id]: state }) }
  forget(id: string): void {
    if (!this.getSnapshot()[id]) return
    const next = { ...this.getSnapshot() }; delete next[id]; this.publish(next)
  }
  /** The tab's session ended (closed, or lost), and its transaction with it. */
  sessionEnded(id: string): void {
    const state = this.getSnapshot()[id]
    if (state?.session) this.update(id, { ...state, session: undefined })
  }
  /** Runs the active query, or the query `tabId` names. */
  execute(tabId = this.documents.getSnapshot().activeId): Promise<void> {
    if (!this.canExecute(tabId)) return Promise.resolve()
    const run = this.run(tabId)
    this.runs.set(tabId, run)
    return run.finally(() => { if (this.runs.get(tabId) === run) this.runs.delete(tabId) })
  }
  private async run(tabId: string): Promise<void> {
    const document = this.documents.get(tabId)!
    const connection = this.getConnection(document.connectionId!)!
    const { sql, startLine } = this.documents.getExecuteText(tabId)
    if (!sql.trim()) return
    const queryId = crypto.randomUUID(), previous = this.getSnapshot()[tabId]?.session
    // Reserve before the first await so repeated commands cannot start a second script.
    this.update(tabId, { running: { queryId, connectionId: connection.id, startedAt: this.now() }, session: previous })
    let summary: QueryResult | undefined, error: string | undefined, code: ErrorCode | undefined
    try {
      // The run's events are followed before the script is sent, so no early result set is missed.
      this.results.begin(tabId, queryId)
      this.events.emit({ type: 'query.started', tabId, queryId })
      const response = await this.api.execute({ connectionId: connection.id, sessionId: tabId, database: document.database, sql, startLine, queryId, ...queryLimits, timeoutSeconds: connection.commandTimeout ?? 0 })
      if (response.ok) summary = response.value
      else { error = response.error; code = response.code }
    } catch (failure) { error = errorText(failure) }
    if (this.disposed) return
    // A run that settles after its tab closed (a cancel that took longer than cancelSettleMs) still frees its results.
    if (!this.documents.get(tabId)) { this.results.finish(tabId, queryId, { summary, error, code }); return }
    if (this.getSnapshot()[tabId]?.running?.queryId !== queryId) return
    if (summary?.database) this.documents.update(tabId, { database: summary.database })
    // A summary means the backend ran the script in a session; the first one after a reconnect is a new session.
    let notice: string | undefined
    if (summary && this.documents.get(tabId)?.sessionNotice) {
      notice = newSessionMessage
      this.documents.update(tabId, { sessionNotice: false })
    }
    // A summary carries the session's SPID and login while it is open (none when it was lost or never opened); a failure
    // that left no session ends it, and any other failure leaves the session as it was.
    const session: QuerySession | undefined = summary ? summary.spid === undefined ? undefined : { connectionId: connection.id, spid: summary.spid, login: summary.login }
      : sessionGone.has(code) ? undefined : previous
    this.results.finish(tabId, queryId, { summary, error, code, notice })
    this.update(tabId, { summary, error, session })
    this.events.emit({ type: 'query.finished', tabId, queryId, summary, error })
  }
  /** Cancels the active query, or the one running in `tabId`. */
  async cancel(tabId = this.documents.getSnapshot().activeId): Promise<void> {
    const running = this.getSnapshot()[tabId]?.running
    if (!running || this.disposed) return
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
   * at a time), asks about the open transactions and running queries in main's message box, then cancels the running ones
   * and waits (up to 15 s) for them to stop. Resolves to how each session ends, or to undefined when the user chose Cancel
   * or Keep Running; with nothing to ask, to an empty plan. An executing query is never committed: the prompt says that
   * what it left open is rolled back.
   */
  async confirmSessions(action: SessionAction, tabIds: readonly string[]): Promise<SessionPlan | undefined> {
    const candidates = tabIds.flatMap(id => {
      const document = this.documents.get(id)
      return document ? [{ id, name: document.name.slice(0, sessionPromptLimits.name), running: this.isRunning(id), state: nothingOpen }] : []
    })
    const idle = candidates.filter(tab => !tab.running)
    for (let next = 0; next < idle.length; next += stateReads) {
      await Promise.all(idle.slice(next, next + stateReads).map(async tab => { tab.state = await this.transactionState(tab.id) }))
      if (this.disposed) return undefined
    }
    const tabs = candidates.filter(tab => tab.running || tab.state.transactions > 0 || tab.state.unchecked).slice(0, sessionPromptLimits.tabs)
    if (!tabs.length) return new Map()
    const response = await this.api.confirmSessions({
      action, tabs: tabs.map(tab => ({ name: tab.name, running: tab.running, transactions: tab.running ? 0 : tab.state.transactions, ...!tab.running && tab.state.unchecked ? { unchecked: true as const } : {} }))
    })
    if (!response.ok) throw new Error(response.error)
    if (response.value === 'cancel' || this.disposed) return undefined
    const running = tabs.filter(tab => tab.running).map(tab => tab.id)
    await Promise.all(running.map(id => this.cancel(id)))
    const stopped = Promise.all(running.map(id => this.runs.get(id)?.catch(() => {})))
    await Promise.race([stopped, this.wait(cancelSettleMs)])
    return new Map(tabs.map(tab => [tab.id, !tab.running && response.value === 'commit' ? 'commit' : 'rollback']))
  }
  dispose(): void { this.disposed = true; this.subscription.dispose(); this.clearListeners(); this.publish({}) }
}
