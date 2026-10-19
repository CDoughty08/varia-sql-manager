import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { isQueryDocument, type QueryDocument } from '../documents'
import type { ConnectionService } from './connections'
import type { DocumentService } from './documents'
import type { FileService } from './files'
import type { QueryService } from './queries'

export type TargetPatch = Partial<Pick<QueryDocument, 'connectionId' | 'database'>>
const unwrap = <T>(result: ApiResult<T>): T => { if (!result.ok) throw new Error(result.error); return result.value }
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'The operation failed.'

/** Which server and database each query runs against. The toolbar, Object Explorer, and the pickers all go through it. */
export class TargetService {
  constructor(
    private readonly documents: DocumentService,
    private readonly queries: Pick<QueryService, 'isRunning'>,
    private readonly connections: Pick<ConnectionService, 'get'>,
    private readonly files: Pick<FileService, 'clearError' | 'reportError'>,
    private readonly api: Pick<VariaApi, 'closeQuerySession'>
  ) {}
  update(tabId: string, patch: TargetPatch): void {
    const current = this.documents.get(tabId)
    if (current && Object.entries(patch).every(([key, value]) => current[key as keyof TargetPatch] === value)) return
    // A value opened from the results (XML, JSON, plan) never has a server or database.
    if (current && !isQueryDocument(current)) return
    // The query's results stay, as in SSMS: they live until it runs again, closes, or the user closes them.
    this.documents.update(tabId, patch)
  }
  /**
   * Moves a query to another server (or disconnects it), ending its session first so no transaction follows it.
   * Choosing the server it already uses keeps the session, with its open transaction, temp tables, and SET options.
   */
  async changeConnection(tabId: string, connectionId?: string): Promise<void> {
    const document = this.documents.get(tabId)
    if (!document || !isQueryDocument(document)) return
    const next = connectionId === undefined ? undefined : this.connections.get(connectionId)
    if (document.connectionId === next?.id) return
    const database = next?.database ?? document.database
    await this.runDocumentTask(async () => {
      unwrap(await this.api.closeQuerySession(tabId))
      this.update(tabId, { connectionId: next?.id, database })
    })
  }
  changeDatabase(tabId: string, database: string): void { this.update(tabId, { database }) }
  /** After an explicit Reconnect, the lost connection's queries move to the new one (keeping their results), and the
   *  next execution of each says that it runs in a new session. Nothing else ever retargets a query this way. */
  retarget(oldId: string, newId: string): void {
    for (const document of this.documents.getSnapshot().documents) if (document.connectionId === oldId) this.documents.update(document.id, { connectionId: newId, sessionNotice: true })
  }
  /** Disconnects every query that is not running, ending its session; the running ones stay connected and are reported. */
  async disconnectAll(): Promise<void> {
    await this.runDocumentTask(async () => {
      let running = 0
      for (const { id, connectionId } of this.documents.getSnapshot().documents) {
        if (connectionId === undefined) continue
        if (this.queries.isRunning(id)) { running++; continue }
        unwrap(await this.api.closeQuerySession(id))
        this.update(id, { connectionId: undefined })
      }
      if (running) throw new Error(running === 1 ? '1 query is still running and stayed connected.' : `${running} queries are still running and stayed connected.`)
    })
  }
  /** Runs a task under the document lock, reporting failures in the file error banner. */
  async runDocumentTask(action: () => Promise<void>): Promise<void> {
    if (this.documents.getSnapshot().busy) return
    this.files.clearError()
    try { await this.documents.runTask(action) }
    catch (error) { this.files.reportError(errorText(error)) }
  }
}
