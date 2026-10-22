import type { ConnectionInfo, QueryResult, VariaApi } from '../../../shared/contracts'
import type { ErrorCode } from '../../../shared/ipc/wire/protocol'
import { sessionPromptLimits, type SessionAction, type SessionEnd } from '../../../shared/sessions'
import { defaultSettings, type SettingsValues } from '../../../shared/settings/catalog'
import { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResultsService } from '../results/ResultsService'
import { isQueryDocument, type SessionNotice } from '../documents'
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
export const lostSessionMessage = 'This query opened a new SQL session. The previous session was lost (SQL Server ended it, or its connection broke), so SQL Server rolled back its open transaction, and its SET options and temporary tables no longer exist.'
const noticeMessages: Readonly<Record<SessionNotice, string>> = { restarted: newSessionMessage, lost: lostSessionMessage }
/** A live connection: its Advanced properties' command timeout, when the profile set one, wins over Tools › Options. */
type QueryConnection = ConnectionInfo & { readonly lost?: true; readonly options?: { readonly advanced?: { readonly commandTimeout?: number } } }
/** Rows are bounded only by the backend's memory budget; result sets by Tools › Options (up to 1,000, by default all). */
export const queryLimits = { maxRows: 0 } as const
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

export class QueryService extends SnapshotStore<QuerySnapshot> implements Disposable {
  private disposed = false
  /** Each running execution, so closing its tab can wait for the cancel to land. */
  private readonly runs = new Map<string, Promise<void>>()
  private readonly subscription: Disposable
  constructor(private documents: DocumentService, private api: QueryApi, private getConnection: (id: string) => QueryConnection | undefined, private events: EventBus,
    private results: Pick<ResultsService, 'begin' | 'finish'>, private now: () => number = () => Date.now(), private wait: (ms: number) => Promise<void> = ms => new Promise(resolve => { setTimeout(resolve, ms) }),
    private settings: () => SettingsValues = () => defaultSettings) {
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
  /** Whether the query is on a live connection, so it may have a session to read. */
  private connected(id: string): boolean {
    // Only a query has a session: a table designer's connection is not one to read.
    const document = this.documents.get(id), connectionId = isQueryDocument(document) ? document?.connectionId : undefined, connection = connectionId ? this.getConnection(connectionId) : undefined
    return !this.disposed && !!connection && !connection.lost
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
  /** What Tools › Options and the connection's Advanced properties ask of an execution; `stopOnError` only when on. */
  private executionOptions(connection: QueryConnection) {
    const settings = this.settings()
    return {
      ...queryLimits, maxResultSets: settings['queryResults.grid.maxResultSets'],
      timeoutSeconds: connection.options?.advanced?.commandTimeout ?? settings['queryExecution.executionTimeout'],
      ...settings['queryExecution.stopOnError'] ? { stopOnError: true } : {}
    }
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
      const response = await this.api.execute({ connectionId: connection.id, sessionId: tabId, database: document.database, sql, startLine, queryId, ...this.executionOptions(connection) })
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
    const reason = this.documents.get(tabId)?.sessionNotice
    if (summary && reason) {
      notice = noticeMessages[reason]
      this.documents.update(tabId, { sessionNotice: undefined })
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
   * at a time, within `stateBudgetMs` in all), then asks in main's message box: first whether to cancel the executing
   * queries (Keep Running is the default), then about the open transactions (Yes, commit, is the default), as SSMS asks
   * each window. It then cancels the running queries (a few at a time) and waits (up to 15 s) for them to stop. Resolves
   * to how each session ends, or to undefined when the user chose Cancel or Keep Running; with nothing to ask, to an empty
   * plan. An executing query is never committed: the prompt says that what it left open is rolled back.
   */
  async confirmSessions(action: SessionAction, tabIds: readonly string[]): Promise<SessionPlan | undefined> {
    const candidates = tabIds.flatMap(id => {
      const document = this.documents.get(id), running = this.isRunning(id)
      // A session not read in time may hold a transaction; a query with no live connection has none to read.
      return document ? [{ id, name: document.name.slice(0, sessionPromptLimits.name), running, state: !running && this.connected(id) ? mayBeOpen : nothingOpen }] : []
    })
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
    const tabs = candidates.filter(tab => tab.running || tab.state.transactions > 0 || tab.state.unchecked).slice(0, sessionPromptLimits.tabs)
    if (!tabs.length) return new Map()
    const running = tabs.filter(tab => tab.running), open = tabs.filter(tab => !tab.running)
    const ask = async (asked: typeof tabs) => {
      const response = await this.api.confirmSessions({
        action, tabs: asked.map(tab => ({ name: tab.name, running: tab.running, transactions: tab.running ? 0 : tab.state.transactions, ...!tab.running && tab.state.unchecked ? { unchecked: true as const } : {} }))
      })
      if (!response.ok) throw new Error(response.error)
      return this.disposed ? 'cancel' : response.value
    }
    if (running.length && await ask(running) === 'cancel') return undefined
    const answer = open.length ? await ask(open) : 'rollback'
    if (answer === 'cancel') return undefined
    for (let next = 0; next < running.length; next += sessionRequests) await Promise.all(running.slice(next, next + sessionRequests).map(tab => this.cancel(tab.id)))
    const stopped = Promise.all(running.map(tab => this.runs.get(tab.id)?.catch(() => {})))
    await Promise.race([stopped, this.wait(cancelSettleMs)])
    return new Map(tabs.map(tab => [tab.id, !tab.running && answer === 'commit' ? 'commit' : 'rollback']))
  }
  dispose(): void { this.disposed = true; this.subscription.dispose(); this.clearListeners(); this.publish({}) }
}
