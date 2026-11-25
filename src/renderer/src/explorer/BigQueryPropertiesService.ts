import type { BigQueryDryRunResult } from '../../../shared/bigquery/dry-run'
import { bigQueryPath } from '../../../shared/bigquery/names'
import { bigQueryPreviewRows, bigQueryPropertyKinds, type BigQueryProperties, type BigQueryPropertyKind } from '../../../shared/bigquery/objects'
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { NodeSubtype } from '../../../shared/explorer/catalog'
import type { ObjectRef } from '../../../shared/explorer/refs'
import { defaultScriptingOptions, type ScriptingOptions } from '../../../shared/scripting/options'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { ExplorerMenuNode } from '../menus/targets'
import type { ResultsService } from '../results/ResultsService'
import { isLiveConnection, type ConnectionAvailability } from '../services/connection-availability'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import { isBigQueryTabAvailable, type BigQueryPropertiesTabId } from './bigquery-properties-format'

export type BigQueryDdlState =
  | { readonly status: 'loading'; readonly phase: 'estimating' | 'reading' }
  | { readonly status: 'ready'; readonly text: string; readonly warnings: readonly string[] }
  | { readonly status: 'error'; readonly message: string }

export type BigQueryPreviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly key: string; readonly rowsRead?: number }
  | { readonly status: 'error'; readonly message: string }

/** One Properties tab: the object it describes, its structured metadata, active tab, and optional on-demand DDL / Preview Rows state. */
export interface BigQueryPropertiesView {
  readonly connectionId: string
  readonly kind: BigQueryPropertyKind
  readonly subtype?: NodeSubtype
  readonly project: string
  readonly dataset: string
  readonly name: string
  readonly activeTab: BigQueryPropertiesTabId
  readonly loading: boolean
  readonly value?: BigQueryProperties
  readonly error?: string
  readonly ddl?: BigQueryDdlState
  readonly preview?: BigQueryPreviewState
}

export interface BigQueryPropertiesSnapshot { readonly views: Readonly<Record<string, BigQueryPropertiesView>> }

export interface BigQueryPropertiesOptions {
  readonly api: Pick<VariaApi, 'bigQueryProperties'> & Partial<Pick<VariaApi, 'scriptObjects' | 'cancelScripting' | 'execute' | 'cancel'>>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider'>
  readonly connections?: ExternalStore<readonly (ConnectionAvailability & { readonly id: string })[]>
  readonly results?: Pick<ResultsService, 'begin' | 'finish' | 'release'>
  readonly scriptingOptions?: ExternalStore<{ readonly options: ScriptingOptions }>
  /** BigQuery's cost prompts before on-demand CREATE DDL runs its billed INFORMATION_SCHEMA query (BigQueryCostService.beforeScript). */
  readonly billedGate?: (connectionId: string, estimate: BigQueryDryRunResult, signal: AbortSignal) => Promise<{ readonly run: boolean; readonly maximumBytesBilled?: number }>
  readonly focus?: (id: string) => void
  readonly newId?: () => string
}

interface DdlFlight {
  requestId?: string
  prompt?: AbortController
  cancelled: boolean
}

interface PreviewRun {
  readonly key: string
  readonly queryId: string
  running: boolean
}

const isPropertyKind = (kind: string): kind is BigQueryPropertyKind => (bigQueryPropertyKinds as readonly string[]).includes(kind)
const previewTimeoutSeconds = 110
const disconnectedMessage = 'The connection is no longer open.'
const previewUnavailableMessage = 'Preview Rows is not available for this object.'
const ddlUnavailableMessage = 'Loading table DDL is not available on this connection.'

const settled = <T>(request: Promise<ApiResult<T>>): Promise<ApiResult<T>> =>
  request.catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }) as ApiResult<T>)

const reportCancel = (result: Promise<ApiResult<unknown>> | undefined) => {
  if (!result) return
  void result.then(value => { if (!value.ok) onUnexpectedError(new Error(value.error)) }, onUnexpectedError)
}

const previewSqlFor = (view: Pick<BigQueryPropertiesView, 'project' | 'dataset' | 'name'>): string =>
  `SELECT *\nFROM ${bigQueryPath(view.project, view.dataset, view.name)}\nLIMIT ${bigQueryPreviewRows};\n`

/**
 * BigQuery's Properties (docs/bigquery.md, Properties): a read-only document tab of a table-like object's structured
 * metadata from free `tables.get`, with explicit on-demand table DDL (estimated and cost-gated, never auto-run) and
 * lazy free `tabledata.list` Preview Rows loaded only when the Preview Rows tab is selected.
 */
export class BigQueryPropertiesService extends SnapshotStore<BigQueryPropertiesSnapshot> implements CustomDocumentProvider, Disposable {
  readonly kind = 'bigQueryProperties' as const
  readonly inSaveAll = false
  readonly saves = false
  private readonly registration: Disposable
  private readonly unsubscribeConnections?: () => void
  private readonly requests = new Map<string, string>()
  private readonly ddlFlights = new Map<string, DdlFlight>()
  private readonly previewRuns = new Map<string, PreviewRun>()
  private readonly newId: () => string
  private disposed = false

  constructor(private readonly o: BigQueryPropertiesOptions) {
    super({ views: {} })
    this.newId = o.newId ?? (() => crypto.randomUUID())
    this.registration = o.documents.registerProvider(this)
    this.unsubscribeConnections = o.connections?.subscribe(() => this.connectionsChanged())
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
    this.set(document.id, {
      connectionId: node.connectionId,
      kind: object.kind,
      ...(node.subtype === undefined ? {} : { subtype: node.subtype }),
      project: object.project,
      dataset: object.dataset,
      name: object.name,
      activeTab: 'overview',
      loading: true
    })
    void this.refresh(document.id)
    return document.id
  }

  view(id: string): BigQueryPropertiesView | undefined { return this.getSnapshot().views[id] }

  /** Whether the tab's connection is currently live. */
  isLive(connectionId: string): boolean {
    if (!this.o.connections) return true
    return this.o.connections.getSnapshot().some(connection => connection.id === connectionId && isLiveConnection(connection))
  }

  /** Whether on-demand billed CREATE DDL can be loaded for `id` right now. */
  canLoadDdl(id: string): boolean {
    const view = this.view(id)
    return !this.disposed && !!view && !view.loading && !!view.value && view.value.definition === undefined && view.ddl?.status !== 'loading'
      && !!this.o.api.scriptObjects && !!this.o.billedGate && this.isLive(view.connectionId)
  }

  /**
   * Selects a section tab on document `id`. Lazy-loads free Preview Rows ONLY when `'preview'` is chosen;
   * NEVER triggers billed SQL on `'definition'`.
   */
  selectTab(id: string, tab: BigQueryPropertiesTabId): void {
    const view = this.view(id)
    if (!view || this.disposed) return
    if (view.activeTab !== tab) this.set(id, { ...view, activeTab: tab })
    if (tab === 'preview' && view.kind === 'bqTable') {
      const latest = this.view(id)
      if (latest && (!latest.preview || latest.preview.status === 'error')) {
        void this.loadPreview(id)
      }
    }
  }

  /** Reads the metadata again; drops stale answers, clears any loaded DDL, and refreshes Preview Rows only if active. */
  async refresh(id: string): Promise<void> {
    const view = this.view(id)
    if (!view || this.disposed) return
    if (!this.isLive(view.connectionId)) {
      this.set(id, { ...view, loading: false, error: disconnectedMessage })
      return
    }
    this.stopDdl(id)
    const reloadPreview = view.activeTab === 'preview' && view.kind === 'bqTable'
    this.releasePreview(id)
    const requestId = this.newId()
    this.requests.set(id, requestId)
    this.set(id, { ...view, loading: true, error: undefined, ddl: undefined, preview: undefined })
    if (reloadPreview) void this.loadPreview(id)
    const result = await settled(this.o.api.bigQueryProperties({
      connectionId: view.connectionId, requestId, kind: view.kind, project: view.project, dataset: view.dataset, name: view.name
    }))
    const current = this.view(id)
    if (!current || this.disposed || this.requests.get(id) !== requestId) return
    this.requests.delete(id)
    if (result.ok) {
      if (result.value.definition !== undefined) this.stopDdl(id)
      const activeTab = isBigQueryTabAvailable(current.activeTab, current.kind, result.value) ? current.activeTab : 'overview'
      this.set(id, {
        ...current,
        loading: false,
        value: result.value,
        error: undefined,
        activeTab,
        ...(result.value.definition !== undefined ? { ddl: undefined } : {})
      })
    } else {
      this.set(id, { ...current, loading: false, error: result.error })
    }
  }

  /**
   * Explicitly loads a table's CREATE DDL on demand via `scripting.script`: runs a free dry-run estimate first,
   * passes through BigQuery's cost prompts (`billedGate`), and executes only if approved. Declining returns to idle.
   */
  async loadDdl(id: string): Promise<void> {
    const view = this.view(id)
    const scriptObjects = this.o.api.scriptObjects
    const gate = this.o.billedGate
    if (this.disposed || !view || view.loading || !view.value || view.value.definition !== undefined) return
    if (!scriptObjects || !gate) {
      this.set(id, { ...view, ddl: { status: 'error', message: ddlUnavailableMessage } })
      return
    }
    if (!this.isLive(view.connectionId)) {
      this.set(id, { ...view, ddl: { status: 'error', message: disconnectedMessage } })
      return
    }
    this.stopDdl(id)
    const flight: DdlFlight = { cancelled: false }
    this.ddlFlights.set(id, flight)
    const active = () => !this.disposed && !flight.cancelled && this.ddlFlights.get(id) === flight && !!this.view(id)
    const updateDdl = (ddl: BigQueryDdlState | undefined) => {
      const latest = this.view(id)
      if (latest && active()) this.set(id, { ...latest, ddl })
    }
    const target: ObjectRef = { kind: view.kind, project: view.project, dataset: view.dataset, name: view.name }
    const options = this.o.scriptingOptions?.getSnapshot().options ?? defaultScriptingOptions
    const request = { connectionId: view.connectionId, targets: [target], verb: 'create' as const, options }

    updateDdl({ status: 'loading', phase: 'estimating' })
    let requestId = this.newId()
    flight.requestId = requestId
    const estimated = await settled(scriptObjects({ ...request, requestId, estimateOnly: true }))
    if (!active() || flight.requestId !== requestId) return
    flight.requestId = undefined
    if (!estimated.ok) { this.finishDdl(id, flight, { status: 'error', message: estimated.error }); return }
    if (estimated.value.error) { this.finishDdl(id, flight, { status: 'error', message: estimated.value.error.message }); return }

    let answer: { readonly run: boolean; readonly maximumBytesBilled?: number } = { run: true }
    if (estimated.value.estimate) {
      const prompt = new AbortController()
      flight.prompt = prompt
      try {
        answer = await gate(view.connectionId, estimated.value.estimate, prompt.signal).catch(() => ({ run: false }))
      } finally {
        if (flight.prompt === prompt) flight.prompt = undefined
      }
      if (!active() || prompt.signal.aborted) return
    }
    if (!answer.run) {
      this.finishDdl(id, flight, undefined)
      return
    }
    if (!this.isLive(view.connectionId)) {
      this.finishDdl(id, flight, { status: 'error', message: disconnectedMessage })
      return
    }

    updateDdl({ status: 'loading', phase: 'reading' })
    requestId = this.newId()
    flight.requestId = requestId
    const result = await settled(scriptObjects({
      ...request,
      requestId,
      ...(answer.maximumBytesBilled === undefined ? {} : { maximumBytesBilled: answer.maximumBytesBilled })
    }))
    if (!active() || flight.requestId !== requestId) return
    flight.requestId = undefined
    if (!result.ok) { this.finishDdl(id, flight, { status: 'error', message: result.error }); return }
    if (result.value.error) { this.finishDdl(id, flight, { status: 'error', message: result.value.error.message }); return }
    if (result.value.text === undefined) {
      this.finishDdl(id, flight, { status: 'error', message: `BigQuery produced no CREATE statement for ${view.name}.` })
      return
    }
    this.finishDdl(id, flight, { status: 'ready', text: result.value.text, warnings: result.value.warnings })
  }

  /** Cancels any in-flight on-demand DDL request or open cost prompt and returns the tab to its Load DDL prompt. */
  cancelDdl(id: string): void {
    this.stopDdl(id)
    const view = this.view(id)
    if (view && view.ddl?.status === 'loading') this.set(id, { ...view, ddl: undefined })
  }

  /** Loads (or reloads) free Preview Rows via `tabledata.list` into a bare `ResultsService` entry. */
  async reloadPreview(id: string): Promise<void> {
    await this.loadPreview(id)
  }

  /** Cancels an in-flight Preview Rows read. */
  cancelPreview(id: string): void {
    const run = this.previewRuns.get(id)
    if (!run || !run.running) return
    this.releasePreview(id)
    const view = this.view(id)
    if (view && view.preview?.status === 'loading') {
      this.set(id, { ...view, preview: { status: 'error', message: 'Preview cancelled.' } })
    }
  }

  private async loadPreview(id: string): Promise<void> {
    const view = this.view(id)
    if (this.disposed || !view) return
    if (view.kind !== 'bqTable' || !this.o.results || !this.o.api.execute) {
      this.set(id, { ...view, preview: { status: 'error', message: previewUnavailableMessage } })
      return
    }
    if (!this.isLive(view.connectionId)) {
      this.set(id, { ...view, preview: { status: 'error', message: disconnectedMessage } })
      return
    }
    this.releasePreview(id)
    const run: PreviewRun = { key: this.newId(), queryId: this.newId(), running: true }
    this.previewRuns.set(id, run)
    this.set(id, { ...view, preview: { status: 'loading' } })
    try {
      this.o.results.begin(run.key, run.queryId, undefined, { bare: true })
    } catch (error) {
      onUnexpectedError(error)
      if (this.previewRuns.get(id) === run) this.previewRuns.delete(id)
      const current = this.view(id)
      if (current && !this.disposed) {
        this.set(id, { ...current, preview: { status: 'error', message: error instanceof Error && error.message ? error.message : previewUnavailableMessage } })
      }
      return
    }

    const response = await settled(this.o.api.execute({
      connectionId: view.connectionId,
      sessionId: run.key,
      sql: previewSqlFor(view),
      queryId: run.queryId,
      maxRows: bigQueryPreviewRows,
      timeoutSeconds: previewTimeoutSeconds,
      maxResultSets: 1,
      preview: { project: view.project, dataset: view.dataset, table: view.name }
    }))
    run.running = false
    const summary = response.ok ? response.value : undefined
    try {
      await this.o.results.finish(run.key, run.queryId, response.ok
        ? { summary }
        : { error: response.error, ...(response.code ? { code: response.code } : {}) })
    } catch (error) {
      onUnexpectedError(error)
      const isCurrent = this.previewRuns.get(id) === run
      if (isCurrent) this.previewRuns.delete(id)
      this.safeReleaseResults(run.key)
      const current = this.view(id)
      if (isCurrent && current && !this.disposed) {
        this.set(id, { ...current, preview: { status: 'error', message: error instanceof Error && error.message ? error.message : previewUnavailableMessage } })
      }
      return
    }
    if (this.disposed || this.previewRuns.get(id) !== run || !this.view(id)) {
      this.safeReleaseResults(run.key)
      return
    }
    const current = this.view(id)!
    if (summary?.resultSets.length) {
      this.set(id, { ...current, preview: { status: 'ready', key: run.key, rowsRead: summary.resultSets[0].rowsRead } })
      return
    }
    this.releasePreview(id)
    const message = !response.ok
      ? response.error
      : summary?.error?.message ?? summary?.messages.find(entry => entry.kind === 'error')?.text ?? previewUnavailableMessage
    this.set(id, { ...current, preview: { status: 'error', message } })
  }

  private finishDdl(id: string, flight: DdlFlight, state: BigQueryDdlState | undefined): void {
    if (this.ddlFlights.get(id) === flight) this.ddlFlights.delete(id)
    const view = this.view(id)
    if (view && !this.disposed && !flight.cancelled) this.set(id, { ...view, ddl: state })
  }

  private stopDdl(id: string): void {
    const flight = this.ddlFlights.get(id)
    if (!flight) return
    this.ddlFlights.delete(id)
    flight.cancelled = true
    flight.prompt?.abort()
    if (flight.requestId && this.o.api.cancelScripting) {
      try { reportCancel(this.o.api.cancelScripting([flight.requestId])) } catch (error) { onUnexpectedError(error) }
    }
  }

  private releasePreview(id: string): void {
    const run = this.previewRuns.get(id)
    if (!run) return
    this.previewRuns.delete(id)
    if (run.running && this.o.api.cancel) {
      run.running = false
      try { reportCancel(this.o.api.cancel(run.queryId)) } catch (error) { onUnexpectedError(error) }
    }
    this.safeReleaseResults(run.key)
  }

  private safeReleaseResults(key: string): void {
    try { this.o.results?.release(key) } catch (error) { onUnexpectedError(error) }
  }

  private connectionsChanged(): void {
    if (this.disposed) return
    const views = this.getSnapshot().views
    for (const [id, view] of Object.entries(views)) {
      if (this.isLive(view.connectionId)) continue
      const requestPending = view.loading || this.requests.has(id)
      const ddlLoading = view.ddl?.status === 'loading'
      const previewNeedsUpdate = view.preview !== undefined
        && !(view.preview.status === 'error' && view.preview.message === disconnectedMessage)
      if (!requestPending && !ddlLoading && !previewNeedsUpdate && !this.ddlFlights.has(id) && !this.previewRuns.has(id)) continue
      if (requestPending) this.requests.delete(id)
      this.stopDdl(id)
      this.releasePreview(id)
      const current = this.view(id)
      if (!current) continue
      if (!requestPending && !ddlLoading && !previewNeedsUpdate) continue
      this.set(id, {
        ...current,
        ...(requestPending ? { loading: false, error: disconnectedMessage } : {}),
        ...(ddlLoading ? { ddl: { status: 'error', message: disconnectedMessage } } : {}),
        ...(previewNeedsUpdate ? { preview: { status: 'error', message: disconnectedMessage } } : {})
      })
    }
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
    this.stopDdl(id)
    this.releasePreview(id)
    const { [id]: _closed, ...views } = this.getSnapshot().views
    this.publish({ views })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.ddlFlights.keys()]) this.stopDdl(id)
    for (const id of [...this.previewRuns.keys()]) this.releasePreview(id)
    this.requests.clear()
    this.unsubscribeConnections?.()
    this.registration.dispose()
    this.clearListeners()
  }
}
