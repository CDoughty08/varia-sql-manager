import type { ConnectionInfo, QueryResult, VariaApi } from '../../../shared/contracts'
import { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import { DocumentService } from './documents'

export interface RunningQuery { readonly queryId: string; readonly connectionId: string }
export interface QueryState { readonly running?: RunningQuery; readonly result?: QueryResult; readonly error?: string }
export type QuerySnapshot = Readonly<Record<string, QueryState>>
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'The operation failed.'

export class QueryService extends SnapshotStore<QuerySnapshot> implements Disposable {
  private disposed = false
  constructor(private documents: DocumentService, private api: Pick<VariaApi, 'execute' | 'cancel'>, private getConnection: (id: string) => ConnectionInfo | undefined, private events: EventBus) { super({}) }
  isRunning(id: string): boolean { return !!this.getSnapshot()[id]?.running }
  isConnectionRunning(id: string): boolean { return Object.values(this.getSnapshot()).some(state => state.running?.connectionId === id) }
  canExecute(): boolean {
    const document = this.documents.active
    return !this.disposed && !this.documents.getSnapshot().busy && !!document?.connectionId && !!this.getConnection(document.connectionId) && !this.isRunning(document.id)
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
    let result: QueryResult | undefined, error: string | undefined
    try {
      this.events.emit({ type: 'query.started', tabId, queryId })
      const response = await this.api.execute({ connectionId: connection.id, sessionId: tabId, database: document.database, sql, startLine, queryId, maxRows: 1000, timeoutSeconds: connection.commandTimeout ?? 0 })
      if (!response.ok) throw new Error(response.error)
      result = response.value
    } catch (failure) { error = errorText(failure) }
    if (this.disposed || !this.documents.get(tabId) || this.getSnapshot()[tabId]?.running?.queryId !== queryId) return
    if (result?.database) this.documents.update(tabId, { database: result.database })
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
