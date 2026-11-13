import { isQueryDocument, type QueryDocument } from '../documents'
import type { ConnectionService } from './connections'
import type { DocumentService } from './documents'
import { unfinished, type FileService } from './files'
import type { QueryService } from './queries'
import type { ConnectionTargetService } from './connection-targets'
import type { ConnectionTarget } from '../../../shared/connection-targets'

export type TargetPatch = Partial<Pick<QueryDocument, 'connectionId' | 'database' | 'targetId' | 'attachWanted'>>
const noTargets: readonly ConnectionTarget[] = Object.freeze([])
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'The operation failed.'

/** Which server and database each query runs against. The toolbar, Object Explorer, and the pickers all go through it. */
export class TargetService {
  constructor(
    private readonly documents: DocumentService,
    private readonly queries: Pick<QueryService, 'isRunning' | 'mayHaveTransaction' | 'confirmSessions'>,
    private readonly connections: Pick<ConnectionService, 'get'>,
    private readonly files: Pick<FileService, 'clearError' | 'reportError'>,
    private readonly registry?: Pick<ConnectionTargetService, 'get' | 'getSnapshot' | 'subscribe'>
  ) {}
  getSnapshot = (): readonly ConnectionTarget[] => this.registry?.getSnapshot() ?? noTargets
  subscribe = (listener: () => void): (() => void) => this.registry?.subscribe(listener) ?? (() => {})
  targetForConnection(connectionId: string): string | undefined {
    const connection = this.connections.get(connectionId)
    if (!connection || connection.lost) return undefined
    return this.getSnapshot().find(target => (target.lifecycle.state === 'connected' || target.lifecycle.state === 'disconnecting')
      && target.lifecycle.handle.id === connectionId && target.lifecycle.handle.generation === connection.generation)?.id
  }
  update(tabId: string, patch: TargetPatch): void {
    const current = this.documents.get(tabId)
    if (current && Object.entries(patch).every(([key, value]) => current[key as keyof TargetPatch] === value)) return
    // A value opened from the results (XML, JSON, plan) never has a server or database.
    if (current && !isQueryDocument(current)) return
    // The query's results stay, as in SSMS: they live until it runs again, closes, or the user closes them. A query moved
    // to another connection (or disconnected) starts afresh, so a notice about its old session no longer applies.
    const moved = current && 'connectionId' in patch && patch.connectionId !== current.connectionId
    const targetId = patch.targetId ?? (patch.connectionId ? this.targetForConnection(patch.connectionId) : undefined)
    const association = targetId ? { targetId, attachWanted: patch.attachWanted ?? true } : moved && patch.connectionId ? { targetId: undefined, attachWanted: undefined } : {}
    const remembered = moved && targetId && targetId === current?.targetId ? { database: current.database } : {}
    const notice = moved ? { sessionNotice: targetId && targetId === current?.targetId ? current.sessionNotice ?? 'restarted' as const : undefined } : {}
    const server = moved && !patch.connectionId && current?.connectionId ? this.connections.get(current.connectionId)?.server : undefined
    const hint = patch.connectionId ? { lastServer: undefined } : server ? { lastServer: server } : {}
    this.documents.update(tabId, { ...association, ...patch, ...remembered, ...hint, ...notice })
  }
  /**
   * Moves a query to another server (or disconnects it), ending its session first so no transaction follows it: an open
   * transaction is committed or rolled back as the user answers, and Cancel leaves the query where it was. Choosing the
   * server it already uses keeps the session, with its open transaction, temp tables, and SET options.
   */
  async changeConnection(tabId: string, connectionId?: string): Promise<void> {
    const document = this.documents.get(tabId)
    if (!document || !isQueryDocument(document)) return
    const candidate = connectionId === undefined ? undefined : this.connections.get(connectionId)
    const next = candidate?.lost ? undefined : candidate
    if (document.connectionId === next?.id) {
      if (!connectionId && document.attachWanted) this.documents.update(tabId, { attachWanted: false })
      return
    }
    const targetId = next ? this.targetForConnection(next.id) : document.targetId
    const database = next && (!targetId || targetId !== document.targetId) ? next.database : document.database
    await this.runDocumentTask(async () => {
      const plan = await this.queries.confirmSessions(next ? 'changeConnection' : 'disconnectQuery', [tabId])
      if (!plan) return
      await this.documents.endSession(tabId, plan.get(tabId))
      if (next) {
        const current = this.connections.get(next.id)
        if (!current || current.lost || current.generation !== next.generation || targetId && this.targetForConnection(next.id) !== targetId)
          throw new Error('The selected connection changed while ending the query session. Choose its connection again.')
      }
      this.update(tabId, { connectionId: next?.id, database, targetId, attachWanted: !!next })
    })
  }
  changeDatabase(tabId: string, database: string): void { this.update(tabId, { database }) }
  /** Bind existing documents only by the exact handle that created them; useful at the connect orchestration seam. */
  rememberConnection(connectionId: string, targetId: string): void {
    if (this.targetForConnection(connectionId) !== targetId) return
    for (const document of this.documents.getSnapshot().documents) if (document.connectionId === connectionId)
      this.documents.update(document.id, { targetId, ...isQueryDocument(document) ? { attachWanted: true } : {} })
  }
  /** Reconnect opens fresh sessions for queries that still want this exact target, preserving their own databases. */
  attachTarget(targetId: string, connectionId: string): void {
    if (this.targetForConnection(connectionId) !== targetId) return
    for (const document of this.documents.getSnapshot().documents) {
      if (!isQueryDocument(document) || document.targetId !== targetId || !document.attachWanted || document.connectionId === connectionId) continue
      this.documents.update(document.id, { connectionId, sessionNotice: 'restarted' })
    }
  }
  /** The coordinator has ended sessions already. Keep intent, individual databases and retained result provenance. */
  disconnectTarget(targetId: string, connectionId: string): void {
    for (const document of this.documents.getSnapshot().documents) {
      if (!isQueryDocument(document) || document.targetId !== targetId || document.connectionId !== connectionId) continue
      this.documents.update(document.id, { connectionId: undefined, sessionNotice: 'restarted' })
    }
  }
  /** Compatibility for an explicit Reconnect of an exact prior handle. Registry-backed custom documents follow only
   *  the same target; their providers own draft state. Restored queries attach through attachTarget instead. */
  retarget(oldId: string, newId: string): void {
    const targetId = this.targetForConnection(newId)
    const server = this.connections.get(newId)?.server
    for (const document of this.documents.getSnapshot().documents) {
      if (document.connectionId !== oldId) continue
      if (document.targetId && document.targetId !== targetId) continue
      if (isQueryDocument(document)) this.documents.update(document.id, { connectionId: newId, ...targetId ? { targetId, attachWanted: document.attachWanted ?? true } : {}, sessionNotice: 'restarted' })
      else if (targetId && document.targetId === targetId && this.documents.isCustom(document.id)) this.documents.update(document.id, { connectionId: newId })
      // The legacy adapter is retained only until the workbench supplies the registry and the document owners migrate.
      else if (!this.registry && server !== undefined && this.documents.isCustom(document.id) && this.documents.follows(document.id, server)) this.documents.update(document.id, { connectionId: newId })
    }
  }
  /** Disconnects every query that is not running, ending its session (open transactions are asked about once, first);
   *  the running ones stay connected and are reported, and so does one that finished during the prompt with a transaction
   *  nobody was asked about. */
  async disconnectAll(): Promise<void> {
    await this.runDocumentTask(async () => {
      // A table designer has no session to end, and keeps its server, as SSMS's does.
      const asked = new Set(this.documents.getSnapshot().documents.filter(document => isQueryDocument(document) && document.connectionId !== undefined && !this.queries.isRunning(document.id)).map(document => document.id))
      const plan = await this.queries.confirmSessions('disconnectAll', [...asked])
      if (!plan) return
      let running = 0, unasked = 0
      for (const document of this.documents.getSnapshot().documents) {
        const { id, connectionId } = document
        if (connectionId === undefined || !isQueryDocument(document)) continue
        if (this.queries.isRunning(id)) { running++; continue }
        if (!asked.has(id) && await this.queries.mayHaveTransaction(id)) { unasked++; continue }
        await this.documents.endSession(id, plan.get(id))
        this.update(id, { connectionId: undefined, attachWanted: false })
      }
      const kept = [running ? (running === 1 ? '1 query is still running and stayed connected.' : `${running} queries are still running and stayed connected.`) : '', unfinished(unasked, 'connected')]
      if (running || unasked) throw new Error(kept.filter(Boolean).join(' '))
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
