import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
// The Integration Services document (D-ssis 6.2): one document per connection that drills in place from the SSIS Catalog's
// operations, live (SSMS's Active Operations dialog and its All Executions, All Validations and All Operations reports), to a
// package's runs and one run's page (SSMS's Overview, All Messages and Execution Performance reports), with Back and Forward
// through every place visited. The backend keeps the operations window (the ssis.operations live source); this service owns
// each document's history, its filters, its live view (reading only while the list is shown), its grid's kept state, the
// selected operation, the tiles' counts and Stop Operation; SsisPlacesService reads the package and run pages. Failures are
// values in the snapshot; nothing throws into React.
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import { liveProbes } from '../../../shared/live/catalog'
import type { SettingsValues } from '../../../shared/settings/catalog'
import { operationKinds, operationStatuses, operationTiles, ssisLimits, type OperationKind, type OperationTile } from '../../../shared/ssis/catalog'
import {
  operationStatusByLabel, operationStoppable, operationsPresetSpecs, operationsTabName, operationTypeByLabel, type OperationsPreset
} from '../../../shared/ssis/operations'
import type { SsisExecuteResult, SsisOperationsArgs } from '../../../shared/ssis/schema'
import { executionOperationType, executionText, isExecutionId } from '../../../shared/ssis/execution'
import {
  canGoBack, canGoForward, currentPlace, keptKeys, pushPlace, startTrail, stepTrail, updatePlace, type SsisPlace, type SsisPlaceTarget, type SsisTrail
} from '../../../shared/ssis/navigation'
import type { SsisPlacesService } from './SsisPlacesService'
import type { SsisOperationsContextState, SsisOperationsKeys } from '../core/contextkeys'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { LiveGrid, LiveGridState } from '../live/LiveGrid'
import { documentOwner, type LiveHandle, type LiveService } from '../live/LiveService'
import type { LiveConnection } from '../services/connections'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import type { PaneService } from '../services/panes'
import type { EditorGroupService } from '../services/editor-groups'

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
  /** The places visited and the one shown: the list, a package's runs or a run's page. */
  readonly trail: SsisTrail
}
/** How a document's view ended by failing: the catalog is missing (nothing to retry until one exists), or another failure
 *  that Retry (Refresh) may get past, such as access granted since. */
export interface SsisOperationsEnd { readonly code?: string; readonly message: string; readonly missing: boolean }
export interface SsisOperationsSnapshot { readonly documents: Readonly<Record<string, SsisOperationsState>> }
export type { SsisOperationsContextState, SsisOperationsKeys }

export interface SsisOperationsServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'executeSsis' | 'cancelSsis'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot' | 'subscribe'>
  readonly panes: Pick<PaneService, 'getSnapshot' | 'subscribe'>
  /** The editor groups: a document shown in any group is visible. */
  readonly groups?: Pick<EditorGroupService, 'getSnapshot' | 'subscribe'>
  readonly live: Pick<LiveService, 'open'>
  /** Reads the package and run pages. */
  readonly places: SsisPlacesService
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
  noRuns: (name: string) => `The catalog has no runs of ${name} that this login may read.`,
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
  private readonly targetBindings: CustomDocumentTargets
  private disposed = false

  constructor(private readonly options: SsisOperationsServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
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
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!connection) throw new Error('Connect to the server first.')
    const existing = this.documentFor(connectionId)
    if (existing) {
      this.setFilters(existing.id, this.presetFilters(preset), preset)
      this.go(existing.id, { kind: 'list' })
      this.options.documents.activate(existing.id)
      return existing.id
    }
    return this.create(connection, preset)
  }

  /** An execution's run page in its connection's document (opened on the list when there is none, so Back reaches it). */
  openExecution(connectionId: string, executionId: number): string {
    if (!isExecutionId(executionId)) throw new Error('An SSIS execution id is a positive integer.')
    const id = this.ensure(connectionId)
    this.go(id, { kind: 'execution', executionId })
    this.options.documents.activate(id)
    return id
  }
  /** A package's runs in its connection's document. */
  openPackage(connectionId: string, folder: string, project: string, name: string): string {
    const id = this.ensure(connectionId)
    this.go(id, { kind: 'package', folder, project, package: name })
    this.options.documents.activate(id)
    return id
  }
  /** A package's newest run: its runs show at once, and its newest run's page follows when they arrive (still shown, with runs). */
  openLastRun(connectionId: string, folder: string, project: string, name: string): string {
    const id = this.openPackage(connectionId, folder, project, name)
    const place = this.place(id)
    if (place?.kind !== 'package') return id
    const settle = () => {
      const read = this.options.places.package(place.key)
      if (read?.loading !== false) return false
      stop()
      if (this.place(id)?.key !== place.key) return true
      const newest = read.model?.runs[0]
      if (newest) this.go(id, { kind: 'execution', executionId: newest.id })
      else if (read.model) this.patch(id, { notice: { tone: 'info', text: operationsText.noRuns(name) } })
      return true
    }
    const stop = this.options.places.subscribe(() => { try { settle() } catch (failure) { onUnexpectedError(failure) } })
    settle()
    return id
  }

  private documentFor(connectionId: string): SsisOperationsState | undefined {
    return Object.values(this.getSnapshot().documents).find(state => state.connectionId === connectionId)
  }
  /** The connection's document, opened on the list with All Executions' filters when there is none. */
  private ensure(connectionId: string): string {
    if (this.disposed) throw new Error('Integration Services is not available.')
    const existing = this.documentFor(connectionId)
    if (existing) return existing.id
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!connection) throw new Error('Connect to the server first.')
    return this.create(connection, 'executions')
  }
  private create(connection: LiveConnection, preset: OperationsPreset): string {
    const label = connection.displayName || connection.server
    const document = this.options.documents.openCustom('ssisOperations', operationsTabName(label), connection.id, 'SSISDB')
    this.targetBindings.bind(document.id, connection.id)
    const state: SsisOperationsState = { id: document.id, connectionId: connection.id, server: connection.server, label, preset, filters: this.presetFilters(preset), stopping: [], trail: startTrail(this.newId()) }
    this.put(state)
    this.subscribeLive(state)
    return document.id
  }

  // --- Places and history ------------------------------------------------------------------------------------------------

  /** The place the document shows. */
  place(id: string): SsisPlace | undefined { const state = this.get(id); return state ? currentPlace(state.trail) : undefined }
  canGoBack(id: string): boolean { const state = this.get(id); return !!state && canGoBack(state.trail) }
  canGoForward(id: string): boolean { const state = this.get(id); return !!state && canGoForward(state.trail) }
  /** Go to a place: a new step after the shown one (the steps ahead are dropped); the place shown already stays as it is. */
  go(id: string, target: SsisPlaceTarget): void {
    const state = this.get(id)
    if (!state) return
    const { trail } = pushPlace(state.trail, target, this.newId())
    if (trail === state.trail) { this.show(id); return }
    this.moved(id, trail)
  }
  /** Back (-1) or Forward (1) one step. */
  step(id: string, delta: -1 | 1): void {
    const state = this.get(id)
    const trail = state && stepTrail(state.trail, delta)
    if (trail) this.moved(id, trail)
  }
  /** The run page's event chips or task changed: the shown step remembers them, and the page reads again under them. */
  setRunFilters(id: string, change: { readonly types?: readonly number[] | null; readonly source?: string | null }): void {
    const state = this.get(id), place = state && currentPlace(state.trail)
    if (!state || place?.kind !== 'execution') return
    // undefined keeps what the place had; null clears it (All, or every task).
    const types = change.types === undefined ? place.types : change.types ?? undefined
    const source = change.source === undefined ? place.source : change.source ?? undefined
    const next: SsisPlace = { kind: 'execution', key: place.key, executionId: place.executionId, ...types ? { types } : {}, ...source ? { source } : {}, ...place.view ? { view: place.view } : {} }
    this.patch(id, { trail: updatePlace(state.trail, () => next) })
    if (this.live(id)) this.options.places.refresh(place.key, next.types, next.source)
  }
  /** The run page's Messages (undefined) or Details, kept by its step; nothing is read again. */
  setRunView(id: string, view: 'details' | undefined): void {
    const state = this.get(id), place = state && currentPlace(state.trail)
    if (!state || place?.kind !== 'execution' || place.view === view) return
    const { view: _view, ...rest } = place
    this.patch(id, { trail: updatePlace(state.trail, () => view ? { ...rest, view } : rest) })
  }

  private moved(id: string, trail: SsisTrail): void {
    const state = this.get(id)
    if (!state) return
    const before = state.trail.places.map(place => place.key)
    this.patch(id, { trail, notice: undefined, confirm: undefined })
    // Places far from the shown one, or no longer in the history, give up what they read.
    this.options.places.keepOnly(keptKeys(trail), before)
    this.show(id)
  }
  /** The shown place reads what it needs: a package's runs or a run's page, unless its read is kept; the list is live. */
  private show(id: string): void {
    const state = this.get(id), place = state && currentPlace(state.trail)
    if (!state?.connectionId || !place || !this.live(id)) return
    if (place.kind === 'execution') this.options.places.showRun(place.key, state.connectionId, place.executionId, place.types, place.source)
    else if (place.kind === 'package') this.options.places.showPackage(place.key, state.connectionId, place.folder, place.project, place.package)
  }
  /** Refresh (F5): the shown place reads again (the list's live view, or the page's read). */
  refreshPlace(id: string): void {
    const place = this.place(id)
    if (!place) return
    if (place.kind === 'list') { this.refresh(id); return }
    if (!this.live(id)) return
    if (!this.options.places.get(place.key)) this.show(id)
    else this.options.places.refresh(place.key, place.kind === 'execution' ? place.types : undefined, place.kind === 'execution' ? place.source : undefined)
  }
  /** Whether Refresh applies to the shown place: the list's view, or a page on a connected server. */
  placeRefreshable(id: string): boolean {
    const place = this.place(id)
    return !!place && (place.kind === 'list' ? this.refreshable(id) : this.live(id))
  }

  private presetFilters(preset: OperationsPreset): SsisOperationsFilters {
    const spec = operationsPresetSpecs[preset]
    return {
      ...spec.kinds ? { kinds: [...spec.kinds] } : {}, ...spec.statuses ? { statuses: [...spec.statuses] } : {},
      windowHours: this.values['integrationServices.operationsWindowHours'], limit: this.values['integrationServices.operationsLimit']
    }
  }

  private subscribeLive(state: SsisOperationsState): void {
    const owner = documentOwner(state.id, this.options.documents, this.options.panes, this.options.groups)
    // The list reads only while it is shown: a package or run page pauses it, as a hidden tab does, and Back resumes it.
    const handle = this.options.live.open({
      connectionId: state.connectionId!, source: operationsSource, args: operationsArgs(state.filters), probes: [{ probe: operationsProbe, intervalMs: this.intervalMs }]
    }, {
      ...owner, connectionId: () => this.live(state.id) ? this.options.documents.get(state.id)?.connectionId : undefined,
      visible: () => owner.visible() && this.place(state.id)?.kind === 'list',
      subscribe: listener => { const stopOwner = owner.subscribe(listener), stopSelf = this.subscribe(listener); return () => { stopOwner(); stopSelf() } }
    })
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
      if (connectionId !== state.connectionId) {
        this.patch(state.id, { connectionId, selected: undefined, confirm: undefined, stopping: [] })
        // A Reconnect: the shown page reads again on the new connection (its kept read was the old one's).
        this.show(state.id)
      }
      else if (!this.live(state.id) && (state.selected || state.confirm || state.stopping.length)) this.patch(state.id, { selected: undefined, confirm: undefined, stopping: [] })
      // A lost connection ends the pages' reads; they keep what they showed.
      if (!this.live(state.id)) this.options.places.stopReads(state.trail.places.map(place => place.key))
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
    if (!this.live(id)) return false
    const snapshot = this.handles.get(id)?.getSnapshot()
    if (!snapshot) return false
    if (snapshot.status !== 'ended') return true
    const end = this.ended(id)
    return !!end && !end.missing
  }
  /** Pause applies while the view runs: an ended one reads nothing to pause. */
  pausable(id: string): boolean { const status = this.handles.get(id)?.getSnapshot().status; return this.live(id) && status !== undefined && status !== 'ended' }

  // --- Filters ---------------------------------------------------------------------------------------------------------

  /** New filters: the backend reads the window again under them. */
  setFilters(id: string, filters: SsisOperationsFilters, preset?: OperationsPreset): void {
    const state = this.get(id)
    if (!state) return
    this.patch(id, { filters, ...preset ? { preset } : {} })
    const handle = this.handles.get(id)
    if (!handle || !this.live(id)) return
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

  /** Whether Open can act on the selected operation: an execution (or a row whose cells are still being read), on a live view. */
  executionSelected(id: string): boolean {
    const state = this.get(id), selected = state?.selected
    return !!selected && !!state.connectionId && (selected.pending || selected.type === executionOperationType) && this.live(id) && this.place(id)?.kind === 'list'
  }
  /** The selected execution once its cells are read, with the connection to read it on; an operation of another type says why
   *  in the document's notice instead. */
  async selectedExecution(id: string): Promise<{ readonly connectionId: string; readonly executionId: number } | undefined> {
    await this.grids.get(id)?.reading
    const state = this.get(id), selected = state?.selected
    if (!selected || selected.pending || !state.connectionId || !this.live(id)) return undefined
    if (selected.type !== executionOperationType) { this.patch(id, { notice: { tone: 'info', text: executionText.notExecution(selected.id) } }); return undefined }
    return { connectionId: state.connectionId, executionId: selected.id }
  }

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
    if (!state?.connectionId || !this.live(id) || state.stopping.includes(operation.id)) return
    const connectionId = state.connectionId, targetId = this.options.documents.get(id)?.targetId
    const generation = this.options.connections.getSnapshot().find(connection => connection.id === connectionId)?.generation
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
    if (!now || this.stopRequests.get(id) !== requests || now.connectionId !== connectionId || this.options.documents.get(id)?.targetId !== targetId
      || this.options.connections.getSnapshot().find(connection => connection.id === connectionId)?.generation !== generation || !this.live(id)) return
    this.patch(id, { stopping: now.stopping.filter(item => item !== operation.id), notice: stopNotice(operation, result) })
    // The row turns Stopping, then Canceled, on its own from the live view; reading it now shows the change at once.
    if (result.ok && !result.value.error) this.handles.get(id)?.refresh()
  }

  refresh(id: string): void { if (this.refreshable(id)) this.handles.get(id)?.refresh() }
  togglePause(id: string): void {
    const handle = this.handles.get(id)
    if (handle && this.pausable(id)) handle.setUserPaused(!this.paused(id))
  }
  dismissNotice(id: string): void { if (this.get(id)?.notice) this.patch(id, { notice: undefined }) }
  /** Copy (with headers): the rows selected in the grid, as the results grid copies them. */
  async copy(id: string, headers: boolean): Promise<void> {
    const result = await this.grids.get(id)?.grid.copy(headers)
    if (result && !result.ok && result.code !== 'CANCELLED') this.patch(id, { notice: { tone: 'error', text: operationsText.copyFailed(result.error), code: result.code } })
  }

  /** Whether the document's server is connected, so its pages can read. */
  connected(id: string): boolean { return this.live(id) }
  private live(id: string): boolean {
    const connectionId = this.get(id)?.connectionId
    return this.targetBindings.matchesConnection(id, connectionId) && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected'))
  }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------

  /** Nothing to save: the document shows the catalog as it is. */
  save(): Promise<boolean> { return Promise.resolve(true) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  /** Legacy server-name reassociation is refused; reconnect callers must supply durable identity. */
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  /** A Stop Operation the user confirmed still goes through when its document closes: only its answer is dropped. */
  closed(id: string): void {
    const keys = this.get(id)?.trail.places.map(place => place.key) ?? []
    this.options.places.keepOnly(new Set(), keys)
    this.targetBindings.forget(id)
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
    this.targetBindings.clear()
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
    for (const id of Object.keys(this.getSnapshot().documents)) {
      const list = this.place(id)?.kind === 'list'
      byDocument[id] = {
        stoppable: list && this.stoppable(id), paused: this.paused(id), refreshable: this.placeRefreshable(id), pausable: list && this.pausable(id),
        place: this.place(id)?.kind ?? 'list', canGoBack: this.canGoBack(id), canGoForward: this.canGoForward(id)
      }
    }
    const current = this.contextStore.getSnapshot().byDocument
    const same = Object.keys(byDocument).length === Object.keys(current).length
      && Object.entries(byDocument).every(([id, keys]) => (Object.keys(keys) as (keyof SsisOperationsKeys)[]).every(key => current[id]?.[key] === keys[key]))
    if (!same) this.contextStore.set({ byDocument })
  }
}

/** The tiles, in the catalogue's order. */
export const tiles = operationTiles
