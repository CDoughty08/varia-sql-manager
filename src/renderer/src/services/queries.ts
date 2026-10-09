import type { ApiResult, ConnectionInfo, DisplayQueryResult, QueryOptions, VariaApi } from '../../../shared/contracts'
import { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { DocumentService } from './documents'

/** `rowsRead` counts rows read so far across the script's result sets (progress events). */
export interface RunningQuery { readonly queryId: string; readonly connectionId: string; readonly rowsRead?: number }
export interface QueryState { readonly running?: RunningQuery; readonly result?: DisplayQueryResult; readonly error?: string }
/** Executes a script and materialises its results (results/legacy.ts), reporting rows read while it runs. */
export interface QueryApi {
  execute(options: QueryOptions, onProgress?: (rowsRead: number) => void): Promise<ApiResult<DisplayQueryResult>>
  cancel: VariaApi['cancel']
}
export type QuerySnapshot = Readonly<Record<string, QueryState>>
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'The operation failed.'
export const newSessionMessage = 'This query opened a new SQL session. The previous session ended when the SQL backend restarted, so its SET options, temporary tables, and open transaction no longer exist.'
type QueryConnection = ConnectionInfo & { readonly lost?: true }

export class QueryService extends SnapshotStore<QuerySnapshot> implements Disposable {
  private disposed = false
  constructor(private documents: DocumentService, private api: QueryApi, private getConnection: (id: string) => QueryConnection | undefined, private events: EventBus) { super({}) }
  isRunning(id: string): boolean { return !!this.getSnapshot()[id]?.running }
  isConnectionRunning(id: string): boolean { return Object.values(this.getSnapshot()).some(state => state.running?.connectionId === id) }
  canExecute(): boolean {
    const document = this.documents.active
    const connection = document?.connectionId ? this.getConnection(document.connectionId) : undefined
    return !this.disposed && !this.documents.getSnapshot().busy && !!connection && !connection.lost && !this.isRunning(document!.id)
  }
  private update(id: string, state: QueryState): void { this.publish({ ...this.getSnapshot(), [id]: state }) }
  clear(id: string): void {
    if (!this.isRunning(id)) this.forget(id)
  }
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
    this.update(tabId, { running: { queryId, connectionId: connection.id } })
    let result: DisplayQueryResult | undefined, error: string | undefined
    const progress = (rowsRead: number) => {
      const state = this.getSnapshot()[tabId]
      if (!this.disposed && state?.running?.queryId === queryId && state.running.rowsRead !== rowsRead) this.update(tabId, { ...state, running: { ...state.running, rowsRead } })
    }
    try {
      this.events.emit({ type: 'query.started', tabId, queryId })
      const response = await this.api.execute({ connectionId: connection.id, sessionId: tabId, database: document.database, sql, startLine, queryId, maxRows: 1000, timeoutSeconds: connection.commandTimeout ?? 0 }, progress)
      if (!response.ok) throw new Error(response.error)
      result = response.value
    } catch (failure) { error = errorText(failure) }
    if (this.disposed || !this.documents.get(tabId) || this.getSnapshot()[tabId]?.running?.queryId !== queryId) return
    if (result?.database) this.documents.update(tabId, { database: result.database })
    // A result means the backend ran the script in a session; the first one after a reconnect is a new session.
    if (result && this.documents.get(tabId)?.sessionNotice) {
      result = { ...result, messages: [newSessionMessage, ...result.messages] }
      this.documents.update(tabId, { sessionNotice: false })
    }
    this.update(tabId, { result, error })
    this.events.emit({ type: 'query.finished', tabId, queryId, result, error })
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
