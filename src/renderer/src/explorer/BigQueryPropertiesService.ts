import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { bigQueryPropertyKinds, type BigQueryProperties, type BigQueryPropertyKind } from '../../../shared/bigquery/objects'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'

/** One Properties tab: the object it describes, and its facts, or why they could not be read. */
export interface BigQueryPropertiesView {
  readonly connectionId: string
  readonly kind: BigQueryPropertyKind
  readonly project: string
  readonly dataset: string
  readonly name: string
  readonly loading: boolean
  readonly value?: BigQueryProperties
  readonly error?: string
}
export interface BigQueryPropertiesSnapshot { readonly views: Readonly<Record<string, BigQueryPropertiesView>> }
export interface BigQueryPropertiesOptions {
  readonly api: Pick<VariaApi, 'bigQueryProperties'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider'>
  readonly focus?: (id: string) => void
}

const isPropertyKind = (kind: string): kind is BigQueryPropertyKind => (bigQueryPropertyKinds as readonly string[]).includes(kind)

/**
 * BigQuery's Properties (docs/bigquery.md, Properties): a read-only document tab of a table-like object's facts from tables.get,
 * which is free. Refresh reads them again; the tab has nothing to save, never follows a reconnect and never reaches AutoRecover.
 */
export class BigQueryPropertiesService extends SnapshotStore<BigQueryPropertiesSnapshot> implements CustomDocumentProvider, Disposable {
  readonly kind = 'bigQueryProperties' as const
  readonly inSaveAll = false
  readonly saves = false
  private readonly registration: Disposable
  private readonly requests = new Map<string, string>()
  private disposed = false

  constructor(private readonly o: BigQueryPropertiesOptions) {
    super({ views: {} })
    this.registration = o.documents.registerProvider(this)
  }

  /** Whether `node` has BigQuery Properties: a table, snapshot, clone, view, materialized view or external table. */
  canOpen(node: ExplorerMenuNode | undefined): node is ExplorerMenuNode {
    return !!node && !node.lost && node.ref.type === 'object' && isPropertyKind(node.ref.object.kind) && node.ref.object.project !== undefined && node.ref.object.dataset !== undefined
  }

  /** Opens `node`'s Properties in a new tab, active; resolves to the document's id. */
  open(node: ExplorerMenuNode | undefined): string | undefined {
    if (this.disposed || !this.canOpen(node) || node.ref.type !== 'object') return undefined
    const object = node.ref.object
    if (!isPropertyKind(object.kind) || object.project === undefined || object.dataset === undefined || object.name === undefined) return undefined
    const document = this.o.documents.openCustom('bigQueryProperties', object.name, node.connectionId, object.dataset)
    this.set(document.id, { connectionId: node.connectionId, kind: object.kind, project: object.project, dataset: object.dataset, name: object.name, loading: true })
    void this.refresh(document.id)
    return document.id
  }

  view(id: string): BigQueryPropertiesView | undefined { return this.getSnapshot().views[id] }

  /** Reads the facts again; an older read's answer is dropped. */
  async refresh(id: string): Promise<void> {
    const view = this.view(id)
    if (!view || this.disposed) return
    const requestId = crypto.randomUUID()
    this.requests.set(id, requestId)
    this.set(id, { ...view, loading: true, error: undefined })
    let result: ApiResult<BigQueryProperties>
    try { result = await this.o.api.bigQueryProperties({ connectionId: view.connectionId, requestId, kind: view.kind, project: view.project, dataset: view.dataset, name: view.name }) }
    catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) } }
    const current = this.view(id)
    if (!current || this.disposed || this.requests.get(id) !== requestId) return
    this.requests.delete(id)
    this.set(id, result.ok ? { ...current, loading: false, value: result.value, error: undefined } : { ...current, loading: false, error: result.error })
  }

  private set(id: string, view: BigQueryPropertiesView): void { this.publish({ views: { ...this.getSnapshot().views, [id]: view } }) }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------
  save(): Promise<boolean> { return Promise.resolve(false) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.o.focus?.(id) }
  follows(): boolean { return false }
  closed(id: string): void {
    this.requests.delete(id)
    const { [id]: _closed, ...views } = this.getSnapshot().views
    this.publish({ views })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.requests.clear()
    this.registration.dispose()
    this.clearListeners()
  }
}
