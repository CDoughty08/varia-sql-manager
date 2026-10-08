import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { QueryDocument } from '../documents'
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
    private readonly queries: Pick<QueryService, 'clear'>,
    private readonly connections: Pick<ConnectionService, 'get'>,
    private readonly files: Pick<FileService, 'clearError' | 'reportError'>,
    private readonly api: Pick<VariaApi, 'closeQuerySession'>
  ) {}
  update(tabId: string, patch: TargetPatch): void {
    const current = this.documents.get(tabId)
    // Re-selecting the current target keeps the query's results.
    if (current && Object.entries(patch).every(([key, value]) => current[key as keyof TargetPatch] === value)) return
    this.documents.update(tabId, patch)
    this.queries.clear(tabId)
  }
  /**
   * Moves a query to another server (or disconnects it), ending its session first so no transaction follows it.
   * Choosing the server it already uses keeps the session, with its open transaction, temp tables, and SET options.
   */
  async changeConnection(tabId: string, connectionId?: string): Promise<void> {
    const document = this.documents.get(tabId)
    if (!document) return
    const next = connectionId === undefined ? undefined : this.connections.get(connectionId)
    if (document.connectionId === next?.id) return
    const database = next?.database ?? document.database
    await this.runDocumentTask(async () => {
      unwrap(await this.api.closeQuerySession(tabId))
      this.update(tabId, { connectionId: next?.id, database })
    })
  }
  changeDatabase(tabId: string, database: string): void { this.update(tabId, { database }) }
  /** Runs a task under the document lock, reporting failures in the file error banner. */
  async runDocumentTask(action: () => Promise<void>): Promise<void> {
    if (this.documents.getSnapshot().busy) return
    this.files.clearError()
    try { await this.documents.runTask(action) }
    catch (error) { this.files.reportError(errorText(error)) }
  }
}
