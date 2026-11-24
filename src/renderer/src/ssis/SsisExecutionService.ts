// The SSIS execution messages documents (AG-13): one execution's overview and messages as a read-only document tab, read with
// ssis.execution on the SSIS read pool. SSMS's Overview and All Messages reports for one execution, opened from an execution's
// row in Integration Services Operations or from an SSIS step's execution in a job's History. Failures are values in the
// snapshot (a purged execution, no catalog, no access); nothing throws into React.
import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import type { ErrorDetails, VariaApi } from '../../../shared/contracts'
import type { ErrorCode } from '../../../shared/ipc/wire/protocol'
import { catalogDatabase, messageGroups, ssisLimits, type MessageGroup } from '../../../shared/ssis/catalog.ts'
import { executionTitle, isExecutionId, requestGroups, toggleGroup } from '../../../shared/ssis/execution.ts'
import type { SsisExecutionModel } from '../../../shared/ssis/schema.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { GridViewState } from '../results/ResultsService'
import type { LiveConnection } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'

/** A read that failed: the backend's SSIS error value, or main's failure (BACKEND_LOST, CANCELLED, …), as a value. */
export interface SsisExecutionError { readonly code: string; readonly message: string; readonly retryable: boolean; readonly details?: ErrorDetails }

/**
 * One execution document. `loading` is a read in flight (the first, a Refresh or a new type filter over the last good model,
 * which stays shown); `error` is the last read's failure; `gone` means the execution or the catalog is not there (purged by the
 * catalog's retention, or hidden from the login), so only Close helps; `disconnected` means its server is not connected.
 */
export interface SsisExecutionState {
  readonly id: string
  readonly executionId: number
  readonly connectionId: string
  readonly server: string
  readonly serverLabel: string
  readonly loading: boolean
  readonly model?: SsisExecutionModel
  readonly error?: SsisExecutionError
  readonly gone: boolean
  readonly disconnected: boolean
  readonly loadedAt?: number
  /** The message types the list shows, by group; every group by default. */
  readonly groups: readonly MessageGroup[]
  /** The list's grid view (scroll, widths, selection, sort), kept across tab switches and Refresh; mutated by the grid. */
  readonly grid: GridViewState
}
export interface SsisExecutionSnapshot { readonly documents: Readonly<Record<string, SsisExecutionState>> }

export interface SsisExecutionServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'executionSsis' | 'cancelSsis'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot' | 'subscribe'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly focus?: (id: string) => void
  readonly newId?: () => string
  readonly now?: () => number
}

const goneCodes: ReadonlySet<string> = new Set(['NOT_FOUND', 'CATALOG_MISSING', 'NOT_SUPPORTED'])
/** Main's failures that a second read can get past (as for the SSIS properties documents). */
const retryableCodes: ReadonlySet<ErrorCode> = new Set(['BACKEND_LOST', 'BACKEND_UNAVAILABLE', 'BACKEND_CRASH', 'CONNECTION_LOST', 'SESSION_LOST', 'TIMEOUT', 'BUSY', 'TOO_MANY_REQUESTS', 'DUPLICATE_REQUEST'])

export class SsisExecutionService extends SnapshotStore<SsisExecutionSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'ssisExecution' as const
  /** Read-only: nothing to save, so File › Save All passes it by. */
  readonly inSaveAll = false
  private readonly newId: () => string
  private readonly now: () => number
  private readonly registration: Disposable
  private readonly unsubscribe: (() => void)[]
  private readonly requests = new Map<string, string>()
  private readonly targetBindings: CustomDocumentTargets
  private disposed = false

  constructor(private readonly options: SsisExecutionServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.now = options.now ?? Date.now
    this.registration = options.documents.registerProvider(this)
    const guard = (action: () => void) => () => { try { action() } catch (failure) { onUnexpectedError(failure) } }
    this.unsubscribe = [options.connections.subscribe(guard(() => this.connectionsChanged())), options.documents.subscribe(guard(() => this.documentsChanged()))]
  }

  get(id: string | undefined): SsisExecutionState | undefined { return id === undefined ? undefined : this.getSnapshot().documents[id] }

  /** An execution's messages on a connected server: its tab opens at once, reading; one already open for it is shown and read again. */
  open(connectionId: string, executionId: number): string {
    if (this.disposed) throw new Error('SSIS execution messages are not available.')
    if (!isExecutionId(executionId)) throw new Error('An SSIS execution id is a positive integer.')
    const connection = this.live(connectionId)
    if (!connection) throw new Error('Connect to the server first.')
    const existing = Object.values(this.getSnapshot().documents).find(state => state.connectionId === connectionId && state.executionId === executionId)
    if (existing) {
      this.options.documents.activate(existing.id)
      this.refresh(existing.id)
      return existing.id
    }
    const document = this.options.documents.openCustom('ssisExecution', executionTitle(executionId), connection.id, catalogDatabase)
    this.targetBindings.bind(document.id, connection.id)
    this.put({
      id: document.id, executionId, connectionId: connection.id, server: connection.server, serverLabel: connection.displayName || connection.server, loading: false, gone: false,
      disconnected: false, groups: messageGroups, grid: { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false }
    })
    void this.read(document.id)
    return document.id
  }

  /** Whether Refresh can read now: open, connected, and not gone. A read in flight is replaced. */
  canRefresh(id: string | undefined): boolean {
    const state = this.get(id)
    return !!state && !this.disposed && this.targetBindings.matchesConnection(state.id, state.connectionId) && this.options.documents.get(state.id)?.connectionId === state.connectionId && !!this.live(state.connectionId)
  }
  /** Refresh (F5), Retry, and opening the execution again: reads it once more; the shown model stays until the answer. */
  refresh(id: string): void { if (this.canRefresh(id)) void this.read(id) }
  /** A type chip turned on or off: the list reads the newest messages of the groups now chosen. */
  toggleGroup(id: string, group: MessageGroup): void {
    const state = this.get(id)
    if (!state) return
    this.patch(id, { groups: toggleGroup(state.groups, group) })
    this.refresh(id)
  }
  /** Every type again. */
  showAll(id: string): void {
    const state = this.get(id)
    if (!state || state.groups.length === messageGroups.length) return
    this.patch(id, { groups: messageGroups })
    this.refresh(id)
  }

  private async read(id: string): Promise<void> {
    const state = this.get(id)
    if (!state) return
    const previous = this.requests.get(id)
    if (previous) this.cancel([previous])
    const requestId = this.newId(), groups = requestGroups(state.groups)
    this.requests.set(id, requestId)
    this.patch(id, { loading: true })
    let result: Awaited<ReturnType<VariaApi['executionSsis']>>
    try { result = await this.options.api.executionSsis({ connectionId: state.connectionId, requestId, executionId: state.executionId, ...groups ? { groups } : {} }) }
    catch (failure) { result = { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
    if (this.disposed || this.requests.get(id) !== requestId) return
    this.requests.delete(id)
    const current = this.get(id)
    if (!current || this.options.documents.get(id)?.connectionId !== state.connectionId || !this.targetBindings.matchesConnection(id, state.connectionId) || !this.live(state.connectionId)) return
    const model = result.ok ? result.value.model : undefined
    if (model && model.overview.id === state.executionId) {
      this.patch(id, { loading: false, model, error: undefined, gone: false, loadedAt: this.now() })
      return
    }
    const error: SsisExecutionError = result.ok
      ? result.value.error ?? { code: 'BACKEND_ERROR', message: 'The SSIS Catalog sent no execution.', retryable: true }
      : { code: result.code ?? 'BACKEND_ERROR', message: result.error, retryable: result.code !== undefined && retryableCodes.has(result.code), ...result.details ? { details: result.details } : {} }
    // A purged execution drops what was shown: it no longer describes anything in the catalog.
    const gone = goneCodes.has(error.code)
    this.patch(id, { loading: false, error, gone, ...gone ? { model: undefined, loadedAt: undefined } : {} })
  }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------

  save(): Promise<boolean> { return Promise.resolve(true) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  closed(id: string): void {
    const requestId = this.requests.get(id)
    this.requests.delete(id)
    if (requestId) this.cancel([requestId])
    this.targetBindings.forget(id)
    const { [id]: _closed, ...rest } = this.getSnapshot().documents
    this.publish({ documents: rest })
  }

  /** Disconnect cancels the read and keeps the last model. */
  private connectionsChanged(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      const disconnected = !this.live(state.connectionId) || !this.targetBindings.matchesConnection(state.id, state.connectionId) || this.options.documents.get(state.id)?.connectionId !== state.connectionId
      if (disconnected && this.requests.has(state.id)) {
        this.cancel([this.requests.get(state.id)!])
        this.requests.delete(state.id)
        this.patch(state.id, { loading: false })
      }
      if (state.disconnected !== disconnected) this.patch(state.id, { disconnected })
    }
  }
  /** Reconnect moves the tab to the new connection (TargetService.retarget): read again on it. */
  private documentsChanged(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      const connectionId = this.options.documents.get(state.id)?.connectionId
      if (connectionId === undefined || !this.targetBindings.matchesConnection(state.id, connectionId) || connectionId === state.connectionId) {
        if ((connectionId === undefined || !this.targetBindings.matchesConnection(state.id, connectionId)) && !state.disconnected) {
          const requestId = this.requests.get(state.id)
          if (requestId) { this.requests.delete(state.id); this.cancel([requestId]) }
          this.patch(state.id, { disconnected: true, loading: false })
        }
        if (connectionId === state.connectionId && this.targetBindings.matchesConnection(state.id, connectionId) && this.live(connectionId) && state.disconnected) this.patch(state.id, { disconnected: false })
        continue
      }
      const requestId = this.requests.get(state.id)
      if (requestId) { this.requests.delete(state.id); this.cancel([requestId]) }
      const connection = this.live(connectionId)
      this.patch(state.id, { connectionId, loading: false, disconnected: !connection, ...connection ? { serverLabel: connection.displayName || connection.server } : {} })
      this.refresh(state.id)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.targetBindings.clear()
    this.cancel([...this.requests.values()])
    this.requests.clear()
    this.registration.dispose()
    this.unsubscribe.forEach(unsubscribe => unsubscribe())
    this.clearListeners()
  }

  private live(connectionId: string): LiveConnection | undefined {
    return this.options.connections.getSnapshot().find(connection => connection.id === connectionId && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected'))
  }
  private patch(id: string, patch: Partial<SsisExecutionState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as SsisExecutionState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: SsisExecutionState): void { this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } }) }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += ssisLimits.cancelIds) {
      try { void this.options.api.cancelSsis(ids.slice(start, start + ssisLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
