// What the Integration Services document's package and run pages read: one package's runs (ssis.packageRuns) and one run's page
// (ssis.execution), each held under its history entry's key, so Back and Forward show a page as it was left without reading it
// again. The document (SsisOperationsService) owns the history and says which keys to keep; this service reads, refreshes,
// cancels and forgets. Failures are values in the snapshot (a purged execution, no catalog, no access); nothing throws into React.
import type { ErrorDetails, VariaApi } from '../../../shared/contracts'
import type { ErrorCode } from '../../../shared/ipc/wire/protocol'
import { ssisLimits } from '../../../shared/ssis/catalog.ts'
import type { SsisExecutionModel, SsisPackageRunsModel } from '../../../shared/ssis/schema.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { GridViewState } from '../results/ResultsService'

/** A read that failed: the backend's SSIS error value, or main's failure (BACKEND_LOST, CANCELLED, …), as a value. */
export interface SsisPlaceError { readonly code: string; readonly message: string; readonly retryable: boolean; readonly details?: ErrorDetails }

const emptyGrid = (): GridViewState => ({ topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false })

/**
 * One page's read. `loading` is a read in flight (the first, a Refresh or a new filter over the last good model, which stays
 * shown); `error` is the last read's failure; `gone` means the execution or the catalog is not there (purged by the catalog's
 * retention, or hidden from the login), so the page drops its model.
 */
interface PlaceRead<M> {
  readonly key: string
  readonly connectionId: string
  readonly loading: boolean
  readonly model?: M
  readonly error?: SsisPlaceError
  readonly gone: boolean
  readonly loadedAt?: number
}
export interface SsisRunState extends PlaceRead<SsisExecutionModel> {
  readonly kind: 'execution'
  readonly executionId: number
  /** The messages' and parameters' grid views (scroll, widths, selection, sort), mutated by the grids. */
  readonly grids: { readonly messages: GridViewState; readonly parameters: GridViewState }
}
export interface SsisPackageState extends PlaceRead<SsisPackageRunsModel> {
  readonly kind: 'package'
  readonly folder: string
  readonly project: string
  readonly package: string
  readonly grid: GridViewState
}
export type SsisPlaceState = SsisRunState | SsisPackageState
export interface SsisPlacesSnapshot { readonly places: Readonly<Record<string, SsisPlaceState>> }

export interface SsisPlacesServiceOptions {
  readonly api: Pick<VariaApi, 'executionSsis' | 'packageRunsSsis' | 'cancelSsis'>
  readonly newId?: () => string
  readonly now?: () => number
}

const goneCodes: ReadonlySet<string> = new Set(['NOT_FOUND', 'CATALOG_MISSING', 'NOT_SUPPORTED'])
/** Main's failures that a second read can get past (as for the SSIS properties documents). */
const retryableCodes: ReadonlySet<ErrorCode> = new Set(['BACKEND_LOST', 'BACKEND_UNAVAILABLE', 'BACKEND_CRASH', 'CONNECTION_LOST', 'SESSION_LOST', 'TIMEOUT', 'BUSY', 'TOO_MANY_REQUESTS', 'DUPLICATE_REQUEST'])

export class SsisPlacesService extends SnapshotStore<SsisPlacesSnapshot> implements Disposable {
  private readonly newId: () => string
  private readonly now: () => number
  private readonly requests = new Map<string, string>()
  private readonly scrolls = new Map<string, number>()
  private disposed = false

  constructor(private readonly options: SsisPlacesServiceOptions) {
    super({ places: {} })
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.now = options.now ?? Date.now
  }

  get(key: string | undefined): SsisPlaceState | undefined { return key === undefined ? undefined : this.getSnapshot().places[key] }
  run(key: string | undefined): SsisRunState | undefined { const state = this.get(key); return state?.kind === 'execution' ? state : undefined }
  package(key: string | undefined): SsisPackageState | undefined { const state = this.get(key); return state?.kind === 'package' ? state : undefined }

  /** A run page shown: read it unless its read is kept (Back to it) on this connection. */
  showRun(key: string, connectionId: string, executionId: number, types: readonly number[] | undefined, source: string | undefined): void {
    const state = this.run(key)
    if (state && state.connectionId === connectionId && state.executionId === executionId) return
    this.put({ kind: 'execution', key, connectionId, executionId, loading: false, gone: false, grids: { messages: emptyGrid(), parameters: emptyGrid() } })
    void this.read(key, types, source)
  }
  /** A package page shown: read it unless its read is kept on this connection. */
  showPackage(key: string, connectionId: string, folder: string, project: string, name: string): void {
    const state = this.package(key)
    if (state && state.connectionId === connectionId) return
    this.put({ kind: 'package', key, connectionId, folder, project, package: name, loading: false, gone: false, grid: emptyGrid() })
    void this.read(key)
  }

  /** A page's scroll position, kept as the user leaves it so Back puts it back. */
  scrollOf(key: string): number { return this.scrolls.get(key) ?? 0 }
  keepScroll(key: string, top: number): void { if (this.get(key)) this.scrolls.set(key, top) }

  /** Refresh (F5), Retry, a run page's new filters: read once more; the shown model stays until the answer. */
  refresh(key: string, types?: readonly number[], source?: string): void { if (this.get(key)) void this.read(key, types, source) }

  /** Reads still going on a connection that went away end, and their pages keep what they showed. */
  stopReads(keys: Iterable<string>): void {
    for (const key of keys) {
      const requestId = this.requests.get(key)
      if (!requestId) continue
      this.requests.delete(key)
      this.cancel([requestId])
      this.patch(key, { loading: false })
    }
  }

  /** Forget every key but these: the history moved on, or its document closed. A read on its way is cancelled. */
  keepOnly(keep: ReadonlySet<string>, among: Iterable<string>): void {
    const drop = [...among].filter(key => !keep.has(key) && this.get(key))
    if (!drop.length) return
    this.cancel(drop.flatMap(key => { const id = this.requests.get(key); this.requests.delete(key); this.scrolls.delete(key); return id ? [id] : [] }))
    this.publish({ places: Object.fromEntries(Object.entries(this.getSnapshot().places).filter(([key]) => !drop.includes(key))) })
  }

  private async read(key: string, types?: readonly number[], source?: string): Promise<void> {
    const state = this.get(key)
    if (!state || this.disposed) return
    const previous = this.requests.get(key)
    if (previous) this.cancel([previous])
    const requestId = this.newId()
    this.requests.set(key, requestId)
    this.patch(key, { loading: true })
    let result: Awaited<ReturnType<VariaApi['executionSsis']>> | Awaited<ReturnType<VariaApi['packageRunsSsis']>>
    try {
      result = state.kind === 'execution'
        ? await this.options.api.executionSsis({ connectionId: state.connectionId, requestId, executionId: state.executionId, ...types ? { types: [...types] } : {}, ...source ? { source } : {} })
        : await this.options.api.packageRunsSsis({ connectionId: state.connectionId, requestId, folder: state.folder, project: state.project, package: state.package })
    } catch (failure) { result = { ok: false, error: failure instanceof Error ? failure.message : 'The request failed.' } }
    if (this.disposed || this.requests.get(key) !== requestId) return
    this.requests.delete(key)
    const current = this.get(key)
    if (!current || current.connectionId !== state.connectionId) return
    const model = result.ok ? result.value.model : undefined
    if (model && (current.kind !== 'execution' || (model as SsisExecutionModel).overview.id === current.executionId)) {
      this.patch(key, { loading: false, model, error: undefined, gone: false, loadedAt: this.now() } as Partial<SsisPlaceState>)
      return
    }
    const error: SsisPlaceError = result.ok
      ? result.value.error ?? { code: 'BACKEND_ERROR', message: 'The SSIS Catalog sent no answer.', retryable: true }
      : { code: result.code ?? 'BACKEND_ERROR', message: result.error, retryable: result.code !== undefined && retryableCodes.has(result.code), ...result.details ? { details: result.details } : {} }
    // A purged execution drops what was shown: it no longer describes anything in the catalog.
    const gone = goneCodes.has(error.code)
    this.patch(key, { loading: false, error, gone, ...gone ? { model: undefined, loadedAt: undefined } : {} })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel([...this.requests.values()])
    this.requests.clear()
    this.clearListeners()
  }

  private patch(key: string, patch: Partial<SsisPlaceState>): void {
    const state = this.get(key)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as SsisPlaceState & Record<string, unknown>
    for (const name of Object.keys(patch)) if (next[name] === undefined) delete next[name]
    this.put(next)
  }
  private put(state: SsisPlaceState): void { this.publish({ places: { ...this.getSnapshot().places, [state.key]: state } }) }
  private cancel(ids: readonly string[]): void {
    for (let start = 0; start < ids.length; start += ssisLimits.cancelIds) {
      try { void this.options.api.cancelSsis(ids.slice(start, start + ssisLimits.cancelIds)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError) } catch (failure) { onUnexpectedError(failure) }
    }
  }
}
