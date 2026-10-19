import type { ConnectionInfo, QueryResult, VariaApi } from '../../../shared/contracts'
import type { ErrorCode } from '../../../shared/ipc/wire/protocol'
import { sessionPromptLimits, type SessionAction, type SessionEnd } from '../../../shared/sessions'
import { defaultSettings, type SettingsValues } from '../../../shared/settings/catalog'
import { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResultsService } from '../results/ResultsService'
import { DocumentService } from './documents'

export interface RunningQuery { readonly queryId: string; readonly connectionId: string; readonly startedAt: number }
/** The tab's SQL session as probed after its last execution: its open transaction's nesting (@@TRANCOUNT), its SPID and
 *  login. `unchecked` means the session stayed open but the probe read nothing (SET SHOWPLAN_*, NOEXEC, PARSEONLY or
 *  FMTONLY ON, or a timeout), so it may hold a transaction. It belongs to the connection it ran on, so a query moved
 *  elsewhere (or a connection lost) no longer has it. */
export interface QuerySession { readonly connectionId: string; readonly transactions: number; readonly spid?: number; readonly login?: string; readonly unchecked?: true }
/** A tab's last run: its summary (the rows stay in the backend; ResultsService shows them) or main's failure. */
export interface QueryState { readonly running?: RunningQuery; readonly summary?: QueryResult; readonly error?: string; readonly session?: QuerySession }
export type QueryApi = Pick<VariaApi, 'execute' | 'cancel' | 'confirmSessions'>
export type QuerySnapshot = Readonly<Record<string, QueryState>>
/** How each tab's session ends after the user answered: its open transaction committed or rolled back first. Tabs it does
 *  not name have nothing to end. */
export type SessionPlan = ReadonlyMap<string, SessionEnd>
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'The operation failed.'
export const newSessionMessage = 'This query opened a new SQL session. The previous session ended when the SQL backend restarted, so its SET options, temporary tables, and open transaction no longer exist.'
/** A live connection: its Advanced properties' command timeout, when the profile set one, wins over Tools › Options. */
type QueryConnection = ConnectionInfo & { readonly lost?: true; readonly options?: { readonly advanced?: { readonly commandTimeout?: number } } }
/** Rows are bounded only by the backend's memory budget; result sets by Tools › Options (up to 1,000, by default all). */
export const queryLimits = { maxRows: 0 } as const
/** Failures after which the tab has no session, so no open transaction. */
const sessionGone: ReadonlySet<ErrorCode | undefined> = new Set<ErrorCode | undefined>(['SESSION_LOST', 'SESSION_CLOSED', 'NOT_CONNECTED', 'CONNECTION_LOST', 'BACKEND_LOST'])
/** How long ending sessions waits for the queries it cancelled to stop; their sessions close (and roll back) either way. */
export const cancelSettleMs = 15_000

/**
 * The tab's session after a summary. A probe gives its transaction count and login. A SPID without one is a session that
 * stayed open but could not be checked: it keeps what was known of it and may hold a transaction. Neither means the
 * session was lost or never opened, so nothing is open.
 */
function probed(summary: QueryResult, connectionId: string, previous: QuerySession | undefined): QuerySession {
  if (summary.transactionCount !== undefined) return { connectionId, transactions: summary.transactionCount, spid: summary.spid, login: summary.login }
  if (summary.spid === undefined) return { connectionId, transactions: 0 }
  const same = previous?.connectionId === connectionId && previous.spid === summary.spid
  return { connectionId, transactions: same ? previous.transactions : 0, spid: summary.spid, login: same ? previous.login : undefined, unchecked: true }
}

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
  /** The open transaction's nesting in the tab's session, as its last execution left it; 0 once the query moved to another
   *  connection or its connection was lost (the server rolled it back). */
  transactions(id: string): number { return this.liveSession(id)?.transactions ?? 0 }
  /** Whether the tab's session may hold a transaction: one it reported, or one its last execution could not check. */
  mayHaveTransaction(id: string): boolean {
    const session = this.liveSession(id)
    return !!session && (session.transactions > 0 || !!session.unchecked)
  }
  /** The tab's session while it can still hold its transaction: on the query's connection, and that connection not lost. */
  private liveSession(id: string): QuerySession | undefined {
    const session = this.getSnapshot()[id]?.session
    if (!session || this.documents.get(id)?.connectionId !== session.connectionId) return undefined
    const connection = this.getConnection(session.connectionId)
    return connection && !connection.lost ? session : undefined
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
    if (summary && this.documents.get(tabId)?.sessionNotice) {
      notice = newSessionMessage
      this.documents.update(tabId, { sessionNotice: false })
    }
    // A summary carries the session's probe (none when the session was lost); a failure that left no session ends its
    // transaction, and any other failure leaves the session as it was.
    const session: QuerySession | undefined = summary ? probed(summary, connection.id, previous) : sessionGone.has(code) ? undefined : previous
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
   * Before sessions end (`action`), asks about the open transactions and running queries among `tabIds` in main's message
   * box, then cancels the running ones and waits (up to 15 s) for them to stop. Resolves to how each session ends, or to
   * undefined when the user chose Cancel or Keep Running; with nothing to ask, to an empty plan at once. An executing
   * query is never committed: the prompt says that what it left open is rolled back.
   */
  async confirmSessions(action: SessionAction, tabIds: readonly string[]): Promise<SessionPlan | undefined> {
    const tabs = tabIds.flatMap(id => {
      const document = this.documents.get(id), running = this.isRunning(id), transactions = this.transactions(id), unchecked = !!this.liveSession(id)?.unchecked
      return document && (running || transactions > 0 || unchecked) ? [{ id, name: document.name.slice(0, sessionPromptLimits.name), running, transactions, ...unchecked ? { unchecked: true as const } : {} }] : []
    }).slice(0, sessionPromptLimits.tabs)
    if (!tabs.length) return new Map()
    const response = await this.api.confirmSessions({ action, tabs: tabs.map(({ id: _id, ...tab }) => tab) })
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
