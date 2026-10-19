import type { ConnectionInfo, QueryResult, VariaApi } from '../../../shared/contracts'
import type { ErrorCode } from '../../../shared/ipc/wire/protocol'
import { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ResultsService } from '../results/ResultsService'
import { DocumentService } from './documents'

export interface RunningQuery { readonly queryId: string; readonly connectionId: string; readonly startedAt: number }
/** A tab's last run: its summary (the rows stay in the backend; ResultsService shows them) or main's failure. */
export interface QueryState { readonly running?: RunningQuery; readonly summary?: QueryResult; readonly error?: string }
export type QueryApi = Pick<VariaApi, 'execute' | 'cancel'>
export type QuerySnapshot = Readonly<Record<string, QueryState>>
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'The operation failed.'
export const newSessionMessage = 'This query opened a new SQL session. The previous session ended when the SQL backend restarted, so its SET options, temporary tables, and open transaction no longer exist.'
type QueryConnection = ConnectionInfo & { readonly lost?: true }
/** Rows are bounded only by the backend's memory budget; up to 1,000 result sets are kept, as SSMS keeps them all. */
export const queryLimits = { maxRows: 0, maxResultSets: 1000 } as const

export class QueryService extends SnapshotStore<QuerySnapshot> implements Disposable {
  private disposed = false
  constructor(private documents: DocumentService, private api: QueryApi, private getConnection: (id: string) => QueryConnection | undefined, private events: EventBus,
    private results: Pick<ResultsService, 'begin' | 'finish'>, private now: () => number = () => Date.now()) { super({}) }
  isRunning(id: string): boolean { return !!this.getSnapshot()[id]?.running }
  isConnectionRunning(id: string): boolean { return Object.values(this.getSnapshot()).some(state => state.running?.connectionId === id) }
  canExecute(): boolean {
    const document = this.documents.active
    const connection = document?.connectionId ? this.getConnection(document.connectionId) : undefined
    return !this.disposed && !this.documents.getSnapshot().busy && !!connection && !connection.lost && !this.isRunning(document!.id)
  }
  private update(id: string, state: QueryState): void { this.publish({ ...this.getSnapshot(), [id]: state }) }
  forget(id: string): void {
    if (!this.getSnapshot()[id]) return
    const next = { ...this.getSnapshot() }; delete next[id]; this.publish(next)
  }
  async execute(): Promise<void> {
    if (!this.canExecute()) return
    const document = this.documents.active!
    const connection = this.getConnection(document.connectionId!)!
    const { sql, startLine } = this.documents.getExecuteText(document.id)
    if (!sql.trim()) return
    const queryId = crypto.randomUUID(), tabId = document.id
    // Reserve before the first await so repeated commands cannot start a second script.
    this.update(tabId, { running: { queryId, connectionId: connection.id, startedAt: this.now() } })
    let summary: QueryResult | undefined, error: string | undefined, code: ErrorCode | undefined
    try {
      // The run's events are followed before the script is sent, so no early result set is missed.
      this.results.begin(tabId, queryId)
      this.events.emit({ type: 'query.started', tabId, queryId })
      const response = await this.api.execute({ connectionId: connection.id, sessionId: tabId, database: document.database, sql, startLine, queryId, ...queryLimits, timeoutSeconds: connection.commandTimeout ?? 0 })
      if (response.ok) summary = response.value
      else { error = response.error; code = response.code }
    } catch (failure) { error = errorText(failure) }
    if (this.disposed || !this.documents.get(tabId) || this.getSnapshot()[tabId]?.running?.queryId !== queryId) return
    if (summary?.database) this.documents.update(tabId, { database: summary.database })
    // A summary means the backend ran the script in a session; the first one after a reconnect is a new session.
    let notice: string | undefined
    if (summary && this.documents.get(tabId)?.sessionNotice) {
      notice = newSessionMessage
      this.documents.update(tabId, { sessionNotice: false })
    }
    this.results.finish(tabId, queryId, { summary, error, code, notice })
    this.update(tabId, { summary, error })
    this.events.emit({ type: 'query.finished', tabId, queryId, summary, error })
  }
  async cancel(): Promise<void> {
    const tabId = this.documents.getSnapshot().activeId
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
  dispose(): void { this.disposed = true; this.clearListeners(); this.publish({}) }
}
