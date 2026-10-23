import type { ErrorDetails, VariaApi } from '../../../shared/contracts'
import { refKey, type ObjectRef } from '../../../shared/explorer/refs.ts'
import { catalogDatabase, isSsisDocumentKind, ssisDocumentName, ssisDocumentSpecs, ssisLimits, type SsisDocumentKind } from '../../../shared/ssis/catalog.ts'
import type { SsisEnvironmentModel, SsisFolderModel, SsisPackageModel, SsisProjectModel } from '../../../shared/ssis/schema.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import { initialFrameState, type FrameState } from '../kit/document-frame'
import type { ExplorerMenuNode } from '../menus/targets'
import type { LiveConnection } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'

export type SsisPropertiesModel = SsisFolderModel | SsisProjectModel | SsisPackageModel | SsisEnvironmentModel
/** A read that failed: the backend's SSIS error value, or main's failure (BACKEND_LOST, CANCELLED, …), as a value. */
export interface SsisPropertiesError { readonly code: string; readonly message: string; readonly retryable: boolean; readonly details?: ErrorDetails }

/**
 * One properties document. `loading` is a read in flight (the first, or a Refresh over the last good model, which stays
 * shown); `error` is the last read's failure; `gone` means the object or the catalog no longer exists, so only Close
 * helps; `disconnected` means its server is not connected, so it cannot read again until it reconnects.
 */
export interface SsisPropertiesState {
  readonly id: string
  readonly kind: SsisDocumentKind
  readonly target: ObjectRef
  readonly connectionId: string
  /** The server the document was opened on (a reconnect moves it only to that server), and the name it shows. */
  readonly server: string
  readonly serverLabel: string
  readonly loading: boolean
  readonly model?: SsisPropertiesModel
  readonly error?: SsisPropertiesError
  readonly gone: boolean
  readonly disconnected: boolean
  /** When the shown model was read (epoch ms). */
  readonly loadedAt?: number
  readonly frame: FrameState
}
export interface SsisPropertiesSnapshot { readonly documents: Readonly<Record<string, SsisPropertiesState>> }

export interface SsisPropertiesServiceOptions {
  readonly api: Pick<VariaApi, 'describeSsis' | 'cancelSsis'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot' | 'subscribe'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  /** Focuses a document's first control (the app's DOM); tests leave it out. */
  readonly focus?: (id: string) => void
  readonly newId?: () => string
  readonly now?: () => number
}

const goneCodes: ReadonlySet<string> = new Set(['NOT_FOUND', 'CATALOG_MISSING'])
const objectKey = (target: ObjectRef) => refKey('', { type: 'object', object: target })

/**
 * The SSIS Catalog's properties documents (D-ssis 6, S1c): Folder, Project, Package and Environment Properties as
 * read-only document tabs, each read with ssis.describe on the SSIS read pool. Opening an object that already has a tab
 * shows that tab and reads it again; Refresh (F5) reads again and keeps the last good model on screen while it does,
 * and after a failure. It is the DocumentService's provider for the four kinds: nothing to save, never dirty, and closing
 * cancels a read in flight. Failures are values in the snapshot; nothing throws into React.
 */
export class SsisPropertiesService extends SnapshotStore<SsisPropertiesSnapshot> implements Disposable {
  private readonly newId: () => string
  private readonly now: () => number
  private readonly registrations: Disposable[]
  private readonly unsubscribe: (() => void)[]
  /** Each document's read in flight, so Close, a disconnect and dispose can cancel it. */
  private readonly requests = new Map<string, string>()
  private disposed = false

  constructor(private readonly options: SsisPropertiesServiceOptions) {
    super({ documents: {} })
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.now = options.now ?? Date.now
    // One provider per kind: DocumentService routes Save, Close and focus by the tab's kind.
    this.registrations = (Object.keys(ssisDocumentSpecs) as SsisDocumentKind[]).map(kind => options.documents.registerProvider(this.provider(kind)))
    const guard = (action: () => void) => () => { try { action() } catch (failure) { onUnexpectedError(failure) } }
    this.unsubscribe = [options.connections.subscribe(guard(() => this.connectionsChanged())), options.documents.subscribe(guard(() => this.documentsChanged()))]
  }

  get(id: string | undefined): SsisPropertiesState | undefined { return id === undefined ? undefined : this.getSnapshot().documents[id] }

  /** Properties on a tree node: its tab opens at once, reading; one already open for the object is shown and read again. */
  open(node: ExplorerMenuNode): string {
    if (this.disposed) throw new Error('SSIS properties are not available.')
    const kind = node.kind, target = node.ref.type === 'object' ? node.ref.object : undefined
    if (!isSsisDocumentKind(kind) || !target || target.kind !== kind || !target.name) throw new Error('Select an SSIS Catalog folder, project, package or environment in Object Explorer.')
    const connection = this.live(node.connectionId)
    if (!connection) throw new Error('Connect to the server first.')
    const key = objectKey(target)
    const existing = Object.values(this.getSnapshot().documents).find(state => state.connectionId === node.connectionId && state.kind === kind && objectKey(state.target) === key)
    if (existing) {
      this.options.documents.activate(existing.id)
      this.refresh(existing.id)
      return existing.id
    }
    const document = this.options.documents.openCustom(kind, ssisDocumentName(kind, target.name), connection.id, catalogDatabase)
    this.put({
      id: document.id, kind, target, connectionId: connection.id, server: connection.server, serverLabel: connection.displayName || connection.server, loading: false, gone: false,
      disconnected: false, frame: initialFrameState(ssisDocumentSpecs[kind].sections)
    })
    void this.describe(document.id)
    return document.id
  }

  /** Whether Refresh can read now: the document is open, connected, and not reading already. */
  canRefresh(id: string | undefined): boolean {
    const state = this.get(id)
    return !!state && !state.loading && !this.disposed && !!this.live(state.connectionId)
  }
  /** Refresh (F5), Retry, and opening the object again: reads it once more; the shown model stays until the answer. */
  refresh(id: string): void { if (this.canRefresh(id)) void this.describe(id) }
  /** The current section and the collapsed ones follow the document across tab switches (its view remounts). */
  setFrame(id: string, frame: FrameState): void { if (this.get(id)?.frame !== frame) this.patch(id, { frame }) }

  private async describe(id: string): Promise<void> {
    const state = this.get(id)
    if (!state) return
    const requestId = this.newId(), view = ssisDocumentSpecs[state.kind].view
    this.requests.set(id, requestId)
    this.patch(id, { loading: true })
    let result: Awaited<ReturnType<VariaApi['describeSsis']>>
    try { result = await this.options.api.describeSsis({ connectionId: state.connectionId, requestId, view, target: state.target }) }
    catch (failure) { result = { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
    // Closed, disconnected or superseded meanwhile: the answer no longer belongs to this document.
    if (this.disposed || this.requests.get(id) !== requestId) return
    this.requests.delete(id)
    const current = this.get(id)
    if (!current) return
    const model = result.ok ? result.value.model : undefined
    if (model && model.view === view) {
      this.patch(id, { loading: false, model: model as SsisPropertiesModel, error: undefined, gone: false, loadedAt: this.now() })
      return
    }
    const error: SsisPropertiesError = result.ok
      ? result.value.error ?? { code: 'BACKEND_ERROR', message: 'The SSIS Catalog sent no properties.', retryable: true }
      : { code: result.code ?? 'BACKEND_ERROR', message: result.error, retryable: result.code !== 'CANCELLED', ...result.details ? { details: result.details } : {} }
    this.patch(id, { loading: false, error, gone: goneCodes.has(error.code) })
  }

  private provider(kind: SsisDocumentKind): CustomDocumentProvider {
    return {
      kind,
      // Read-only: there is never anything to save.
      save: async () => true,
      canClose: () => undefined,
      revision: () => 0,
      focus: id => this.options.focus?.(id),
      closed: id => this.closed(id),
      // Bound to the server it was opened on, as a table designer is: a reconnect moves it only to that server.
      follows: (id, server) => { const state = this.get(id); return !!state && state.server.trim().toLowerCase() === server.trim().toLowerCase() }
    }
  }
  private closed(id: string): void {
    const requestId = this.requests.get(id)
    this.requests.delete(id)
    if (requestId) this.cancel([requestId])
    const { [id]: _closed, ...rest } = this.getSnapshot().documents
    this.publish({ documents: rest })
  }

  /** A server that disconnects: a read in flight is cancelled, and the document says it cannot read until it reconnects. */
  private connectionsChanged(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      const disconnected = !this.live(state.connectionId)
      if (disconnected && this.requests.has(state.id)) {
        this.cancel([this.requests.get(state.id)!])
        this.requests.delete(state.id)
        this.patch(state.id, { loading: false })
      }
      if (disconnected !== this.get(state.id)?.disconnected) this.patch(state.id, { disconnected })
    }
  }
  /** Reconnect moves the tab to the new connection (TargetService.retarget), and a disconnect clears it: read again on the new one. */
  private documentsChanged(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      const connectionId = this.options.documents.get(state.id)?.connectionId
      if (connectionId === undefined || connectionId === state.connectionId) {
        if (connectionId === undefined && !state.disconnected) this.patch(state.id, { disconnected: true })
        continue
      }
      const requestId = this.requests.get(state.id)
      if (requestId) { this.requests.delete(state.id); this.cancel([requestId]) }
      this.patch(state.id, { connectionId, loading: false, disconnected: !this.live(connectionId) })
      this.refresh(state.id)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel([...this.requests.values()])
    this.requests.clear()
    this.registrations.forEach(registration => registration.dispose())
    this.unsubscribe.forEach(unsubscribe => unsubscribe())
    this.clearListeners()
  }

  private live(connectionId: string): LiveConnection | undefined {
    return this.options.connections.getSnapshot().find(connection => connection.id === connectionId && !connection.lost)
  }
  private patch(id: string, patch: Partial<SsisPropertiesState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as SsisPropertiesState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: SsisPropertiesState): void { this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } }) }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += ssisLimits.cancelIds) {
      try { void this.options.api.cancelSsis(ids.slice(start, start + ssisLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
