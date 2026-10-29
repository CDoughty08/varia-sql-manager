// Integration Services Operations (D-ssis 6.2): one document per connection that shows the SSIS Catalog's operations live,
// replacing SSMS's Active Operations dialog and its All Executions, All Validations and All Operations reports. The backend
// keeps the window (the ssis.operations live source); this service owns each document's filters, its live view, its grid's
// kept state, the selected operation, the tiles' counts and Stop Operation. Failures are values in the snapshot; nothing
// throws into React.
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { liveProbes } from '../../../shared/live/catalog'
import type { SettingsValues } from '../../../shared/settings/catalog'
import { operationKinds, operationStatuses, operationTiles, ssisLimits, type OperationKind, type OperationTile } from '../../../shared/ssis/catalog'
import {
  operationStatusByLabel, operationStoppable, operationsPresetSpecs, operationsTabName, operationTypeByLabel, type OperationsPreset
} from '../../../shared/ssis/operations'
import type { SsisExecuteResult, SsisOperationsArgs } from '../../../shared/ssis/schema'
import type { SsisOperationsContextState, SsisOperationsKeys } from '../core/contextkeys'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { LiveGrid, LiveGridState } from '../live/LiveGrid'
import { documentOwner, type LiveHandle, type LiveService } from '../live/LiveService'
import type { LiveConnection } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import type { PaneService } from '../services/panes'

export const operationsProbe = 'ssis.operations.list' as const
export const operationsSource = 'ssis.operations' as const

/** The document's filters, as the source's args carry them; an absent member does not filter. */
export interface SsisOperationsFilters {
  readonly kinds?: readonly OperationKind[]
  readonly statuses?: readonly number[]
  readonly folder?: string
  readonly project?: string
  readonly package?: string
  readonly prefix?: boolean
  readonly caller?: string
  readonly windowHours: number
  readonly limit: number
}
/** The operation the grid's active row shows, read from its cells (the grid holds display text): its id, codes and name;
 *  `pending` until the cells are read. */
export interface SelectedOperation { readonly id: number; readonly type?: number; readonly status?: number; readonly name: string; readonly pending?: true }
export interface SsisOperationsNotice { readonly tone: 'info' | 'error'; readonly text: string; readonly code?: string }
export interface SsisOperationsState {
  readonly id: string
  readonly connectionId?: string
  /** The connection's server, which a Reconnect must reach for the document to follow it. */
  readonly server: string
  /** The server as the document names it (its display name, else the server). */
  readonly label: string
  /** What opened it last (Active Operations, All Executions, …): the header's subtitle. */
  readonly preset: OperationsPreset
  readonly filters: SsisOperationsFilters
  readonly selected?: SelectedOperation
  /** Operations a Stop Operation is on its way for. */
  readonly stopping: readonly number[]
  /** Stop Operation waits for the user's answer about this operation (Tools › Options › Ask before Stop Operation). */
  readonly confirm?: SelectedOperation
  readonly notice?: SsisOperationsNotice
  /** The tiles' counts from the last sample, in the catalogue's tile order (null where the source has none yet). */
  readonly counts?: readonly (number | null)[]
}
/** How a document's view ended by failing: the catalog is missing (nothing to retry until one exists), or another failure
 *  that Retry (Refresh) may get past, such as access granted since. */
export interface SsisOperationsEnd { readonly code?: string; readonly message: string; readonly missing: boolean }
export interface SsisOperationsSnapshot { readonly documents: Readonly<Record<string, SsisOperationsState>> }
export type { SsisOperationsContextState, SsisOperationsKeys }

export interface SsisOperationsServiceOptions {
  readonly api: Pick<VariaApi, 'executeSsis' | 'cancelSsis'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot' | 'subscribe'>
  readonly panes: Pick<PaneService, 'getSnapshot' | 'subscribe'>
  readonly live: Pick<LiveService, 'open'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly settings: ExternalStore<{ readonly values: SettingsValues }>
  /** Focuses a document's grid (the app's DOM); tests leave it out. */
  readonly focus?: (id: string) => void
  readonly newId?: () => string
}

export const operationsText = {
  stopQuestion: (name: string) => `Stop ${name}? It stops after its current work.`,
  stopSent: (id: number) => `Stop Operation sent for operation ${id}. The catalog shows it Stopping until it ends.`,
  stopFailed: (message: string) => `Stop Operation failed: ${message}`,
  notStoppable: (id: number) => `Operation ${id} cannot be stopped: only an execution or validation that is running or pending can be.`,
  noCatalog: 'This server has no SSIS Catalog. Create it on the Integration Services Catalogs node, or connect to a server that has one, then open Operations again.',
  failed: 'Operations stopped reading the catalog.',
  copyFailed: (message: string) => `Could not copy the rows: ${message}`
} as const

/** What a filter's text box may hold: the source's own bounds. */
export const filterBounds = { folder: ssisLimits.name, project: ssisLimits.name, package: ssisLimits.packageName, caller: ssisLimits.name } as const
export type TextFilter = keyof typeof filterBounds

/** The args a document's filters send: only what filters. */
export function operationsArgs(filters: SsisOperationsFilters): SsisOperationsArgs {
  const text = (value?: string) => value && value.length > 0 ? value : undefined
  const folder = text(filters.folder), project = text(filters.project), name = text(filters.package), caller = text(filters.caller)
  return {
    ...filters.kinds?.length ? { kinds: [...filters.kinds] } : {},
    ...filters.statuses?.length ? { statuses: [...filters.statuses] } : {},
    ...folder ? { folder } : {}, ...project ? { project } : {}, ...name ? { package: name } : {},
    ...filters.prefix && (folder || project || name) ? { prefix: true } : {},
    ...caller ? { caller } : {},
    windowHours: filters.windowHours, limit: filters.limit
  }
}

const sameSet = (left?: readonly number[], right?: readonly number[]) => (left?.length ?? 0) === (right?.length ?? 0) && (left ?? []).every(value => right!.includes(value))
/** Whether a tile is pressed: the status filter is exactly its statuses. */
export const tilePressed = (filters: SsisOperationsFilters, tile: OperationTile): boolean => sameSet(filters.statuses, tile.statuses)
/** The filters with a tile pressed (its statuses, and its window when it counts one) or released (every status). */
export function toggleTile(filters: SsisOperationsFilters, tile: OperationTile): SsisOperationsFilters {
  if (tilePressed(filters, tile)) return withoutStatuses(filters)
  return { ...filters, statuses: [...tile.statuses], ...tile.lastHours ? { windowHours: tile.lastHours } : {} }
}
const withoutStatuses = ({ statuses: _statuses, ...rest }: SsisOperationsFilters): SsisOperationsFilters => rest
const toggled = <T>(list: readonly T[] | undefined, value: T, all: readonly T[]): T[] | undefined => {
  const next = list?.includes(value) ? list.filter(item => item !== value) : [...list ?? [], value]
  // Every value on is no filter at all, as is none.
  return next.length === 0 || next.length === all.length ? undefined : all.filter(item => next.includes(item))
}
export const toggleKind = (filters: SsisOperationsFilters, kind: OperationKind): SsisOperationsFilters => {
  const kinds = toggled(filters.kinds, kind, operationKinds)
  const { kinds: _kinds, ...rest } = filters
  return kinds ? { ...rest, kinds } : rest
}
export const toggleStatus = (filters: SsisOperationsFilters, code: number): SsisOperationsFilters => {
  const statuses = toggled(filters.statuses, code, operationStatuses.map(status => status.code))
  const rest = withoutStatuses(filters)
  return statuses ? { ...rest, statuses } : rest
}
/** A name filter set to what was typed, cut to the source's bound, or cleared when empty. */
export function withText(filters: SsisOperationsFilters, field: TextFilter, value: string): SsisOperationsFilters {
  const { [field]: _old, ...rest } = filters
  const text = value.slice(0, filterBounds[field])
  return text.length > 0 ? { ...rest, [field]: text } : rest
}
/** Whether the filters narrow anything beyond the window and limit, so Clear filters has something to do. */
export const filtered = (filters: SsisOperationsFilters): boolean =>
  !!(filters.kinds?.length || filters.statuses?.length || filters.folder || filters.project || filters.package || filters.caller)

/**
 * What Stop Operation's answer says. Nothing left to stop (ALREADY_FINAL: it ended or a stop is on its way; NOT_STARTED: it
 * was created and never started) is information, as SSMS's message box is, never a failure.
 */
export function stopNotice(operation: SelectedOperation, result: ApiResult<SsisExecuteResult>): SsisOperationsNotice {
  if (!result.ok) return { tone: 'error', text: operationsText.stopFailed(result.error), code: result.code }
  const error = result.value.error
  if (!error) return { tone: 'info', text: operationsText.stopSent(operation.id) }
  return error.code === 'ALREADY_FINAL' || error.code === 'NOT_STARTED'
    ? { tone: 'info', text: error.message, code: error.code }
    : { tone: 'error', text: operationsText.stopFailed(error.message), code: error.code }
}

/**
 * The Integration Services Operations documents (custom document kind 'ssisOperations'), one per connection: Active
 * Operations, All Executions, All Validations and All Operations open it with their filters, or show the open one with them.
 */
export class SsisOperationsService extends SnapshotStore<SsisOperationsSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'ssisOperations' as const
  /** A live view with nothing to save: File › Save is not offered on it, and Save All passes it by. */
  readonly saves = false
  readonly inSaveAll = false
  private readonly newId: () => string
  private readonly registration: Disposable
  private readonly stopSettings: () => void
  private readonly stopFollowing: () => void
  private readonly handles = new Map<string, LiveHandle>()
  private readonly gridStates = new Map<string, LiveGridState>()
  private readonly grids = new Map<string, { readonly grid: LiveGrid; readonly stop: () => void; read: number; reading?: Promise<void> }>()
  private readonly stopRequests = new Map<string, Set<string>>()
  private readonly watches = new Map<string, () => void>()
  private readonly contextStore = new (class extends SnapshotStore<SsisOperationsContextState> { set(value: SsisOperationsContextState) { this.publish(value) } clear() { this.clearListeners() } })({ byDocument: {} })
  private refreshSeconds: number
  private limit: number
  private disposed = false

  constructor(private readonly options: SsisOperationsServiceOptions) {
    super({ documents: {} })
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.registration = options.documents.registerProvider(this)
    this.refreshSeconds = this.values['integrationServices.operationsRefreshSeconds']
    this.limit = this.values['integrationServices.operationsLimit']
    // A Reconnect moves a document to the new connection (DocumentService); a lost or closed one disables Stop Operation.
    const follow = () => { try { this.following() } catch (failure) { onUnexpectedError(failure) } }
    const stopDocuments = options.documents.subscribe(follow), stopConnections = options.connections.subscribe(follow)
    this.stopFollowing = () => { stopDocuments(); stopConnections() }
    // Both apply to open documents at once; a new limit reads each window again.
    this.stopSettings = options.settings.subscribe(() => {
      const seconds = this.values['integrationServices.operationsRefreshSeconds'], limit = this.values['integrationServices.operationsLimit']
      if (seconds !== this.refreshSeconds) {
        this.refreshSeconds = seconds
        for (const handle of this.handles.values()) handle.setProbe(operationsProbe, { intervalMs: this.intervalMs })
      }
      if (limit !== this.limit) {
        this.limit = limit
        for (const id of Object.keys(this.getSnapshot().documents)) this.update(id, filters => ({ ...filters, limit }))
      }
    })
  }

  private get values(): SettingsValues { return this.options.settings.getSnapshot().values }
  private get intervalMs(): number {
    const { min, max } = liveProbes[operationsProbe].intervalMs
    return Math.min(max, Math.max(min, this.refreshSeconds * 1000))
  }
  /** The documents' context keys (activeDocumentIsSsisOperations is the document kind's; these are the rest). */
  get context(): ExternalStore<SsisOperationsContextState> { return this.contextStore }
  get(id: string | undefined): SsisOperationsState | undefined { return id === undefined ? undefined : this.getSnapshot().documents[id] }
  handle(id: string): LiveHandle | undefined { return this.handles.get(id) }
  /** The grid's state, kept across remounts (a tab switch) so its scroll, selection and kept keys survive. */
  gridState(id: string): LiveGridState {
    let state = this.gridStates.get(id)
    if (!state) this.gridStates.set(id, state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false })
    return state
  }

  // --- Opening ---------------------------------------------------------------------------------------------------------

  /** Active Operations, All Executions, All Validations or All Operations for a connection: its document, with the preset's filters. */
  open(connectionId: string, preset: OperationsPreset): string {
    if (this.disposed) throw new Error('Integration Services Operations is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost)
    if (!connection) throw new Error('Connect to the server first.')
    const existing = Object.values(this.getSnapshot().documents).find(state => state.connectionId === connectionId)
    if (existing) {
      this.setFilters(existing.id, this.presetFilters(preset), preset)
      this.options.documents.activate(existing.id)
      return existing.id
    }
    const label = connection.displayName || connection.server
    const document = this.options.documents.openCustom('ssisOperations', operationsTabName(label), connection.id, 'SSISDB')
    const state: SsisOperationsState = { id: document.id, connectionId: connection.id, server: connection.server, label, preset, filters: this.presetFilters(preset), stopping: [] }
    this.put(state)
    this.subscribeLive(state)
    return document.id
  }

  private presetFilters(preset: OperationsPreset): SsisOperationsFilters {
    const spec = operationsPresetSpecs[preset]
    return {
      ...spec.kinds ? { kinds: [...spec.kinds] } : {}, ...spec.statuses ? { statuses: [...spec.statuses] } : {},
      windowHours: this.values['integrationServices.operationsWindowHours'], limit: this.values['integrationServices.operationsLimit']
    }
  }

  private subscribeLive(state: SsisOperationsState): void {
    const handle = this.options.live.open({
      connectionId: state.connectionId!, source: operationsSource, args: operationsArgs(state.filters), probes: [{ probe: operationsProbe, intervalMs: this.intervalMs }]
    }, documentOwner(state.id, this.options.documents, this.options.panes))
    this.handles.set(state.id, handle)
    // The view's status decides the Pause, Refresh and Stop Operation keys (an ended view says why in place of its rows);
    // each sample's metrics are the tiles' counts.
    const stopWatch = handle.subscribe(() => this.publishContext())
    const ticks = handle.onTick(({ tick }) => {
      const sample = tick.samples.find(item => item.probe === operationsProbe)
      if (sample?.metrics) this.patch(state.id, { counts: [...sample.metrics] })
    })
    this.watches.set(state.id, () => { stopWatch(); ticks.dispose() })
    this.publishContext()
  }

  private following(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      const connectionId = this.options.documents.get(state.id)?.connectionId
      if (connectionId !== state.connectionId) this.patch(state.id, { connectionId })
    }
    this.publishContext()
  }

  /** How the document's view ended, when it failed: the document then shows why in place of its rows. A view that was
   *  disconnected, or is lost with the backend, is not ended this way (a Reconnect resumes it). */
  ended(id: string): SsisOperationsEnd | undefined {
    const snapshot = this.handles.get(id)?.getSnapshot()
    if (snapshot?.status !== 'ended' || (snapshot.ended ? snapshot.ended.ended !== 'failed' : !snapshot.error)) return undefined
    const code = snapshot.ended?.code ?? snapshot.error?.code
    const missing = code === 'CATALOG_MISSING'
    return { ...code ? { code } : {}, message: missing ? operationsText.noCatalog : snapshot.ended?.message ?? snapshot.error?.message ?? operationsText.failed, missing }
  }
  /** Refresh (and Retry) apply: to a running view, and to one that failed for a reason other than a missing catalog. */
  refreshable(id: string): boolean {
    const snapshot = this.handles.get(id)?.getSnapshot()
    if (!snapshot) return false
    if (snapshot.status !== 'ended') return true
    const end = this.ended(id)
    return !!end && !end.missing
  }
  /** Pause applies while the view runs: an ended one reads nothing to pause. */
  pausable(id: string): boolean { const status = this.handles.get(id)?.getSnapshot().status; return status !== undefined && status !== 'ended' }

  // --- Filters ---------------------------------------------------------------------------------------------------------

  /** New filters: the backend reads the window again under them. */
  setFilters(id: string, filters: SsisOperationsFilters, preset?: OperationsPreset): void {
    const state = this.get(id)
    if (!state) return
    this.patch(id, { filters, ...preset ? { preset } : {} })
    const handle = this.handles.get(id)
    if (!handle) return
    handle.setArgs(operationsArgs(filters))
    // A view that failed reads nothing: new filters (or the document opened again) subscribe again with them.
    if (handle.getSnapshot().status === 'ended') handle.refresh()
  }
  /** Filters changed by a chip, tile or field; nothing is sent when the args stay the same. */
  update(id: string, change: (filters: SsisOperationsFilters) => SsisOperationsFilters): void {
    const state = this.get(id)
    if (!state) return
    const next = change(state.filters)
    if (JSON.stringify(operationsArgs(next)) === JSON.stringify(operationsArgs(state.filters))) this.patch(id, { filters: next })
    else this.setFilters(id, next)
  }
  /** Clear filters: every kind and status, no names, the window and limit kept. */
  clearFilters(id: string): void { this.update(id, ({ windowHours, limit }) => ({ windowHours, limit })) }

  // --- The grid and its selection -----------------------------------------------------------------------------------------

  /** The document's grid mounted (or, with undefined, unmounted): its selection says which operation the verbs act on. */
  attachGrid(id: string, grid: LiveGrid | undefined): void {
    this.grids.get(id)?.stop()
    this.grids.delete(id)
    if (!grid) return
    const entry = { grid, stop: grid.subscribe(() => this.selectionChanged(id)), read: 0 }
    this.grids.set(id, entry)
    this.selectionChanged(id)
  }
  grid(id: string): LiveGrid | undefined { return this.grids.get(id)?.grid }

  private selectionChanged(id: string): void {
    const entry = this.grids.get(id)
    if (!entry) return
    const snapshot = entry.grid.getSnapshot()
    const key = snapshot.activeKey, row = snapshot.selection?.active.row, table = snapshot.table
    const current = this.get(id)?.selected
    if (key === undefined || row === undefined || !table || !/^\d+$/.test(key)) {
      if (current) this.patch(id, { selected: undefined })
      return
    }
    const operation = Number(key)
    // Until its cells are read the operation is known by id only: Stop Operation stays offered (a menu opened by the click
    // that chose the row must not find it greyed) and waits for the read before it decides.
    if (current?.id !== operation) this.patch(id, { selected: { id: operation, name: `operation ${operation}`, pending: true } })
    const read = ++entry.read
    entry.reading = table.handle.getWindow(row, 1, { colStart: 0, colEnd: 7, display: false }).then(window => {
      if (this.grids.get(id) !== entry || entry.read !== read || window.count < 1 || window.text[0] !== key) return
      const [, type, status, , , name, object] = window.text
      const selected: SelectedOperation = { id: operation, type: operationTypeByLabel.get(type), status: operationStatusByLabel.get(status), name: name || object || `operation ${operation}` }
      const before = this.get(id)?.selected
      if (before?.id !== selected.id || before.pending || before.status !== selected.status || before.type !== selected.type || before.name !== selected.name) this.patch(id, { selected })
    }, onUnexpectedError)
  }

  // --- Verbs -------------------------------------------------------------------------------------------------------------

  /** Whether Stop Operation can act on the document's selected operation now. */
  stoppable(id: string): boolean {
    const state = this.get(id), selected = state?.selected
    return !!selected && !!state.connectionId && (selected.pending || operationStoppable(selected.type, selected.status)) && !state.stopping.includes(selected.id) && this.live(id)
  }
  paused(id: string): boolean { return this.handles.get(id)?.getSnapshot().pausedBy === 'user' }

  /** Stop Operation on the selected operation, once its cells are read: asks first unless Tools › Options says not to. */
  async requestStop(id: string): Promise<void> {
    await this.grids.get(id)?.reading
    const state = this.get(id)
    if (!state?.selected || state.selected.pending || !state.connectionId || !this.live(id) || state.stopping.includes(state.selected.id)) return
    if (!operationStoppable(state.selected.type, state.selected.status)) { this.patch(id, { notice: { tone: 'info', text: operationsText.notStoppable(state.selected.id) } }); return }
    if (this.values['integrationServices.confirmStop']) this.patch(id, { confirm: state.selected, notice: undefined })
    else void this.stop(id, state.selected)
  }
  /** The answer to Stop Operation's question: stop, or keep it running. Either way the grid has focus again. */
  answerStop(id: string, stop: boolean): void {
    const confirm = this.get(id)?.confirm
    if (!confirm) return
    this.patch(id, { confirm: undefined })
    if (stop) void this.stop(id, confirm)
    this.options.focus?.(id)
  }

  private async stop(id: string, operation: SelectedOperation): Promise<void> {
    const state = this.get(id)
    if (!state?.connectionId) return
    const requestId = this.newId()
    let requests = this.stopRequests.get(id)
    if (!requests) this.stopRequests.set(id, requests = new Set())
    requests.add(requestId)
    this.patch(id, { stopping: [...state.stopping, operation.id], notice: undefined })
    let result: ApiResult<SsisExecuteResult>
    try {
      result = await this.options.api.executeSsis({ connectionId: state.connectionId, requestId, action: { verb: 'stopOperation', operationId: operation.id } })
    } catch (failure) {
      result = { ok: false, error: failure instanceof Error ? failure.message : String(failure), code: 'BACKEND_ERROR' }
    }
    requests.delete(requestId)
    const now = this.get(id)
    if (!now) return
    this.patch(id, { stopping: now.stopping.filter(item => item !== operation.id), notice: stopNotice(operation, result) })
    // The row turns Stopping, then Canceled, on its own from the live view; reading it now shows the change at once.
    if (result.ok && !result.value.error) this.handles.get(id)?.refresh()
  }

  refresh(id: string): void { this.handles.get(id)?.refresh() }
  togglePause(id: string): void {
    const handle = this.handles.get(id)
    if (handle) handle.setUserPaused(!this.paused(id))
  }
  dismissNotice(id: string): void { if (this.get(id)?.notice) this.patch(id, { notice: undefined }) }
  /** Copy (with headers): the rows selected in the grid, as the results grid copies them. */
  async copy(id: string, headers: boolean): Promise<void> {
    const result = await this.grids.get(id)?.grid.copy(headers)
    if (result && !result.ok && result.code !== 'CANCELLED') this.patch(id, { notice: { tone: 'error', text: operationsText.copyFailed(result.error), code: result.code } })
  }

  private live(id: string): boolean {
    const connectionId = this.get(id)?.connectionId
    return !!connectionId && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost)
  }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------

  /** Nothing to save: the document shows the catalog as it is. */
  save(): Promise<boolean> { return Promise.resolve(true) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  /** It follows a reconnect to the same server, as a query tab does (the view subscribes again there). */
  follows(id: string, server: string): boolean { const state = this.get(id); return !!state && state.server.trim().toLowerCase() === server.trim().toLowerCase() }
  /** A Stop Operation the user confirmed still goes through when its document closes: only its answer is dropped. */
  closed(id: string): void {
    this.stopRequests.delete(id)
    this.attachGrid(id, undefined)
    this.watches.get(id)?.()
    this.watches.delete(id)
    this.handles.get(id)?.dispose()
    this.handles.delete(id)
    this.gridStates.delete(id)
    this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
    this.publishContext()
  }

  dispose(): void {
    if (this.disposed) return
    // The app is closing: stops still on their way are withdrawn rather than left behind with nothing to say how they ended.
    const requests = [...this.stopRequests.values()].flatMap(set => [...set])
    if (requests.length) void this.options.api.cancelSsis(requests).catch(onUnexpectedError)
    for (const id of Object.keys(this.getSnapshot().documents)) this.closed(id)
    this.disposed = true
    this.registration.dispose()
    this.stopSettings()
    this.stopFollowing()
    this.clearListeners()
    this.contextStore.clear()
  }

  // --- Internals ---------------------------------------------------------------------------------------------------------

  private patch(id: string, patch: Partial<SsisOperationsState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as SsisOperationsState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: SsisOperationsState): void {
    this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } })
    this.publishContext()
  }
  private publishContext(): void {
    const byDocument: Record<string, SsisOperationsKeys> = {}
    for (const id of Object.keys(this.getSnapshot().documents)) byDocument[id] = { stoppable: this.stoppable(id), paused: this.paused(id), refreshable: this.refreshable(id), pausable: this.pausable(id) }
    const current = this.contextStore.getSnapshot().byDocument
    const same = Object.keys(byDocument).length === Object.keys(current).length
      && Object.entries(byDocument).every(([id, keys]) => (Object.keys(keys) as (keyof SsisOperationsKeys)[]).every(key => current[id]?.[key] === keys[key]))
    if (!same) this.contextStore.set({ byDocument })
  }
}

/** The tiles, in the catalogue's order. */
export const tiles = operationTiles
