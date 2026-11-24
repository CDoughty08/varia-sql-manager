// BigQuery's Job History (BQ-9, docs/bigquery.md, Job History): one document per BigQuery connection showing the jobs of its
// billing project live. The backend lists them (the bigquery.jobs source, free jobs.list and jobs.get calls); this service owns
// each document's scope and filters, the filter box, the expanded scripts, the grid's kept state and selection, the details
// pane (bigquery.jobs.get), the cancel prompt (bigquery.jobs.cancel), what BigQuery refused on the connection, and the row
// actions that open query tabs: Open Results and Re-attach (query.attach through QueryService), Open SQL and Re-run. Failures
// are values in the snapshot; nothing throws into React.
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import {
  agoText, cancelQuestion, rerunAsks, rerunQuestion, consoleJobLink, defaultJobHistoryFilters, jobHistoryActionState, jobHistoryArgs, jobHistoryLimits, jobHistoryProbe, jobHistorySource,
  jobHistoryStateLabels, jobHistoryStates, jobHistoryTabName, jobHistoryTextColumns, jobHistoryTypeLabels, jobHistoryTypes, qualifiedJobId,
  type HistoryJobRef, type JobHistoryAction, type JobHistoryCancelResult, type JobHistoryDetails, type JobHistoryFilters, type JobHistoryRow, type JobHistoryState as JobState
} from '../../../shared/bigquery/history'
import { liveProbes } from '../../../shared/live/catalog'
import type { SettingsValues } from '../../../shared/settings/catalog'
import type { JobHistoryContextState, JobHistoryKeys } from '../core/contextkeys'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { LiveGrid, LiveGridState } from '../live/LiveGrid'
import { documentOwner, type LiveHandle, type LiveService } from '../live/LiveService'
import type { LiveConnection } from '../services/connections'
import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import type { EditorGroupService } from '../services/editor-groups'
import type { PaneService } from '../services/panes'
import type { QueryService } from '../services/queries'

/** The stored columns the service reads back from a selected row (catalogue order, src/shared/live/catalog.ts). */
const columns = liveProbes[jobHistoryProbe].tables![0].columns.map(column => column.id)
const column = Object.fromEntries(columns.map((id, index) => [id, index])) as Record<string, number>
const stateByLabel = new Map(jobHistoryStates.map(state => [jobHistoryStateLabels[state], state]))
const typeByLabel = new Map(jobHistoryTypes.map(type => [jobHistoryTypeLabels[type], type]))

/** The job the grid's active row shows, read from its cells; `pending` until they are read (every action stays offered, so a
 *  menu opened by the click that chose the row never finds it greyed, and each action waits for the read). */
export interface SelectedJob extends JobHistoryRow { readonly createdAt?: number; readonly pending?: true }
export interface JobHistoryNotice { readonly tone: 'info' | 'error'; readonly text: string; readonly code?: string }
/** The details pane's job: loading, its details, or why they could not be read. */
export interface JobDetailsState { readonly jobId: string; readonly loading: boolean; readonly value?: JobHistoryDetails; readonly error?: { readonly message: string; readonly code?: string } }
/** What the last sample said beyond its rows (the probe's status values). */
export interface JobHistoryStatus { readonly held: number; readonly more: boolean; readonly loading: boolean; readonly unreachable: string; readonly open: number }
/** What BigQuery refused on a connection, remembered for it: listing other users' jobs (All users), reading one (jobs.get) and cancelling one. */
export interface JobHistoryRefusals { readonly all?: string; readonly get?: string; readonly cancel?: string }
export interface JobHistoryState {
  readonly id: string
  readonly connectionId?: string
  /** The billing project the history lists; Copy Job ID and the console link name it. */
  readonly project: string
  readonly label: string
  readonly filters: JobHistoryFilters
  /** The scripts whose statements show under them in the grid, oldest first (at most jobHistoryLimits.expanded). */
  readonly expanded: readonly HistoryJobRef[]
  /** The filter box (job id, user, destination, SQL preview), applied by the backend. */
  readonly text: string
  readonly selected?: SelectedJob
  readonly detailsOpen: boolean
  readonly details?: JobDetailsState
  /** Cancel Job, or Re-run of a statement that may change data or of another user's job, waits for the user's answer. */
  readonly confirm?: { readonly action: 'cancel' | 'rerun'; readonly job: SelectedJob; readonly question: string }
  /** Jobs a cancel is on its way for. */
  readonly cancelling: readonly string[]
  readonly notice?: JobHistoryNotice
  readonly status?: JobHistoryStatus
}
export interface JobHistorySnapshot { readonly documents: Readonly<Record<string, JobHistoryState>> }
/** How a document's view ended by failing: the document shows why in place of its rows, with Retry (Refresh). */
export interface JobHistoryEnd { readonly code?: string; readonly message: string }
export type { JobHistoryContextState, JobHistoryKeys }

export interface JobHistoryServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'bigQueryJob' | 'bigQueryCancelJob' | 'writeClipboardText'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot' | 'subscribe' | 'newQuery'>
  readonly panes: Pick<PaneService, 'getSnapshot' | 'subscribe'>
  readonly groups?: Pick<EditorGroupService, 'getSnapshot' | 'subscribe'>
  readonly live: Pick<LiveService, 'open'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly settings: ExternalStore<{ readonly values: SettingsValues }>
  /** Open Results and Re-attach (query.attach), Re-run (Execute, with the cost rules), and which tab already holds a job. */
  readonly queries: Pick<QueryService, 'restoreJobs' | 'tabHoldingJob' | 'execute'>
  /** Focuses a document's grid (the app's DOM); tests leave it out. */
  readonly focus?: (id: string) => void
  readonly now?: () => number
}

export const jobHistoryText = {
  allUsersDenied: (message?: string) => `BigQuery refused listing every user's jobs on this connection${message ? `: ${message}` : ''}. Job History shows your jobs; All users needs the bigquery.jobs.list permission on the project.`,
  allUsersRefused: 'All users is not available on this connection: BigQuery refused listing every user\'s jobs.',
  cancelSent: (jobId: string) => `Cancel sent for job ${jobId}. BigQuery ends it shortly.`,
  cancelDone: (jobId: string) => `Job ${jobId} had already finished.`,
  cancelled: (jobId: string) => `Job ${jobId} is cancelled.`,
  cancelFailed: (message: string) => `Cancel Job failed: ${message}`,
  cancelDenied: (message: string) => `BigQuery refused cancelling another user's job: ${message} Cancelling other users' jobs needs bigquery.jobs.update on the project.`,
  getDenied: (message: string) => `BigQuery refused reading another user's job: ${message} Reading other users' jobs needs bigquery.jobs.get on the project.`,
  noSql: 'BigQuery returned no SQL for this job.',
  sqlTruncated: 'The job\'s SQL is longer than Varia reads: the tab holds its first part only.',
  copied: (what: string) => `Copied ${what}.`,
  copyFailed: (message: string) => `Could not copy: ${message}`,
  failed: 'Job History stopped reading the jobs.',
  focused: (name: string) => `${name} already holds this job.`,
  notConnected: 'Connect to BigQuery first.'
} as const

const live = (connection: LiveConnection | undefined): boolean => !!connection && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected')
/** How long Show in Job History waits for its project's connection to go live (the Connect dialog it opened). */
export const jobHistoryPendingMs = 10 * 60_000
export const bigQueryProject = (connection: LiveConnection | undefined): string | undefined => connection?.options && 'provider' in connection.options && connection.options.provider === 'bigquery' ? connection.options.project : undefined
/** A created cell's text (yyyy-MM-dd HH:mm:ss in local time) as Unix ms. */
function createdMs(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s] = match.map(Number)
  const value = new Date(y, mo - 1, d, h, mi, s).getTime()
  return Number.isFinite(value) ? value : undefined
}
const bit = (text: string | undefined): boolean => text === '1' || text?.toLowerCase() === 'true'
/** A job read from its row's cells (the probe's column order); undefined for a row that names no job. */
function jobFromCells(text: readonly (string | null | undefined)[]): SelectedJob | undefined {
  const cell = (name: string) => text[column[name]] ?? ''
  const key = cell('job')
  if (!key) return undefined
  const created = cell('created')
  const createdAt = createdMs(created)
  return {
    jobId: key, state: stateByLabel.get(cell('state')) ?? 'done', type: typeByLabel.get(cell('type')) ?? 'other',
    ...cell('location') ? { location: cell('location') } : {}, ...cell('statement') ? { statement: cell('statement') } : {}, ...cell('user') ? { user: cell('user') } : {},
    ...created ? { created } : {}, ...createdAt !== undefined ? { createdAt } : {}, ...cell('parent') ? { parentJobId: cell('parent') } : {},
    mine: bit(cell('mine')), hidden: bit(cell('hidden')), children: Number(cell('children')) || 0
  }
}

/** The context keys of an action on the selected job (JobHistoryKeys): a job still being read keeps every action offered. */
export function actionKeys(job: SelectedJob | undefined, refused: JobHistoryRefusals, cancelling: readonly string[], usable: boolean): Omit<JobHistoryKeys, 'paused' | 'refreshable' | 'pausable'> {
  const can = (action: JobHistoryAction) => usable && !!job && (!!job.pending || jobHistoryActionState(action, job, refused).enabled)
  return {
    selected: usable && !!job, openResults: can('openResults'), reattach: can('reattach'), openSql: can('openSql'), rerun: can('rerun'),
    cancel: can('cancel') && !!job && !cancelling.includes(job.jobId)
  }
}

/** What Cancel Job's answer says: sent (BigQuery ends it shortly), cancelled, already finished (information, never a failure),
 *  or why it failed. */
export function cancelNotice(job: Pick<SelectedJob, 'jobId' | 'mine'>, result: ApiResult<JobHistoryCancelResult>): JobHistoryNotice {
  if (!result.ok) return { tone: 'error', text: result.code === 'PERMISSION_DENIED' && !job.mine ? jobHistoryText.cancelDenied(result.error) : jobHistoryText.cancelFailed(result.error), code: result.code }
  const state = result.value.state
  return { tone: 'info', text: state === 'cancelled' ? jobHistoryText.cancelled(job.jobId) : state === 'done' || state === 'failed' ? jobHistoryText.cancelDone(job.jobId) : jobHistoryText.cancelSent(job.jobId) }
}

/**
 * The Job History documents (custom document kind 'bigQueryJobs'), one per BigQuery connection: the Explorer menus, the palette,
 * a Messages job id and the records dialog open it, or show the open one (filtered to the jobs they name).
 */
export class JobHistoryService extends SnapshotStore<JobHistorySnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'bigQueryJobs' as const
  /** A live view with nothing to save: File › Save is not offered on it, and Save All passes it by. */
  readonly saves = false
  readonly inSaveAll = false
  private readonly registration: Disposable
  private readonly stopFollowing: () => void
  private readonly stopSettings: () => void
  private readonly handles = new Map<string, LiveHandle>()
  private readonly gridStates = new Map<string, LiveGridState>()
  private readonly grids = new Map<string, { readonly grid: LiveGrid; readonly stop: () => void; read: number; reading?: Promise<void> }>()
  private readonly watches = new Map<string, () => void>()
  /** What BigQuery refused, per connection (docs/bigquery.md: remembered for the connection). */
  private readonly refusals = new Map<string, JobHistoryRefusals>()
  /** Requests whose answers a document still waits for: a details read or a cancel, dropped when it closes. */
  private readonly generations = new Map<string, number>()
  /** Show in Job History for jobs on a project not connected yet: opened once a connection to it is live. */
  /** Show in Job History waiting for its project's connection; it lapses after jobHistoryPendingMs (a Connect given up). */
  private pending: { readonly project: string; readonly jobs: readonly HistoryJobRef[]; readonly at: number }[] = []
  private readonly contextStore = new (class extends SnapshotStore<JobHistoryContextState> { set(value: JobHistoryContextState) { this.publish(value) } clear() { this.clearListeners() } })({ byDocument: {} })
  private readonly targetBindings: CustomDocumentTargets
  private prices: boolean
  private disposed = false

  constructor(private readonly options: JobHistoryServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.registration = options.documents.registerProvider(this)
    this.prices = this.pricesSetting()
    // A Reconnect moves a document to the new connection (DocumentService); a lost or closed one disables the actions.
    const follow = () => { try { this.following() } catch (failure) { onUnexpectedError(failure) } }
    const stopDocuments = options.documents.subscribe(follow), stopConnections = options.connections.subscribe(follow)
    this.stopFollowing = () => { stopDocuments(); stopConnections() }
    // Show cost as Bytes only: the Cost column is left empty from the next sample.
    this.stopSettings = options.settings.subscribe(() => {
      const prices = this.pricesSetting()
      if (prices === this.prices) return
      this.prices = prices
      for (const state of Object.values(this.getSnapshot().documents)) this.sendArgs(state.id)
    })
  }

  private pricesSetting(): boolean { return this.options.settings.getSnapshot().values['queryExecution.bigQuery.showCost'] !== 'bytes' }
  private now(): number { return this.options.now?.() ?? Date.now() }
  /** The documents' context keys (activeDocumentIsJobHistory is the document kind's; these are the rest). */
  get context(): ExternalStore<JobHistoryContextState> { return this.contextStore }
  get(id: string | undefined): JobHistoryState | undefined { return id === undefined ? undefined : this.getSnapshot().documents[id] }
  handle(id: string): LiveHandle | undefined { return this.handles.get(id) }
  refused(id: string): JobHistoryRefusals { const connectionId = this.get(id)?.connectionId; return connectionId ? this.refusals.get(connectionId) ?? {} : {} }
  /** The grid's state, kept across remounts (a tab switch) so its scroll, selection and kept keys survive. */
  gridState(id: string): LiveGridState {
    let state = this.gridStates.get(id)
    if (!state) this.gridStates.set(id, state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false })
    return state
  }

  // --- Opening ---------------------------------------------------------------------------------------------------------

  /** The connection's Job History, opened or shown; `jobs` filters it to those jobs (a Messages link, the records dialog). */
  open(connectionId: string, jobs?: readonly HistoryJobRef[]): string {
    if (this.disposed) throw new Error('Job History is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId)
    const project = bigQueryProject(connection)
    if (!connection || !live(connection) || !project) throw new Error(jobHistoryText.notConnected)
    const pinned = jobs?.length ? jobs.slice(0, jobHistoryLimits.pinned) : undefined
    const existing = Object.values(this.getSnapshot().documents).find(state => state.connectionId === connectionId)
    if (existing) {
      // The pinned jobs show whatever the filters say, the search box's included.
      if (pinned) { this.setText(existing.id, ''); this.setFilters(existing.id, { ...existing.filters, jobs: pinned }) }
      this.options.documents.activate(existing.id)
      return existing.id
    }
    const label = connection.displayName || project
    // No database: a new query opened from Job History takes the active document's, and the project is no dataset.
    const document = this.options.documents.openCustom('bigQueryJobs', jobHistoryTabName(label), connection.id, '')
    this.targetBindings.bind(document.id, connection.id)
    const state: JobHistoryState = {
      id: document.id, connectionId: connection.id, project, label, filters: { ...defaultJobHistoryFilters, ...pinned ? { jobs: pinned } : {} }, expanded: [], text: '',
      detailsOpen: false, cancelling: []
    }
    this.put(state)
    this.subscribeLive(state)
    return document.id
  }
  /**
   * Show in Job History for jobs of a project (the records dialog): its live connection's document, filtered to them; with
   * none connected, held until a connection to the project goes live (the caller opens the Connect dialog). True when opened.
   */
  show(project: string, jobs: readonly HistoryJobRef[]): boolean {
    const connection = this.liveFor(project)
    if (connection) { this.open(connection.id, jobs); return true }
    this.pending = [...this.pending.filter(item => item.project !== project), { project, jobs: jobs.slice(0, jobHistoryLimits.pinned), at: this.now() }]
    return false
  }
  /** A Show in Job History whose connection could not be opened waits no longer. */
  forget(project: string): void { this.pending = this.pending.filter(item => item.project !== project) }
  /** The BigQuery projects the page is connected to now (the records dialog offers Show in Job History for these). */
  liveProjects(): string[] { return [...new Set(this.options.connections.getSnapshot().flatMap(item => { const project = live(item) ? bigQueryProject(item) : undefined; return project ? [project] : [] }))] }

  private subscribeLive(state: JobHistoryState): void {
    const owner = documentOwner(state.id, this.options.documents, this.options.panes, this.options.groups)
    const handle = this.options.live.open({
      connectionId: state.connectionId!, source: jobHistorySource, args: jobHistoryArgs(state.filters, state.expanded, this.prices), probes: [{ probe: jobHistoryProbe }]
    }, { ...owner, connectionId: () => this.usable(state.id) ? this.options.documents.get(state.id)?.connectionId : undefined })
    this.handles.set(state.id, handle)
    const stopWatch = handle.subscribe(() => this.publishContext())
    const ticks = handle.onTick(({ tick }) => {
      const sample = tick.samples.find(item => item.probe === jobHistoryProbe)
      if (sample?.status) this.sampled(state.id, sample.status)
    })
    this.watches.set(state.id, () => { stopWatch(); ticks.dispose() })
    this.publishContext()
  }

  /** A sample's status values: the counts and what the status line says, and a refused All users listing, which turns the
   *  document back to My jobs and is remembered for the connection. */
  private sampled(id: string, values: readonly { readonly id: string; readonly value: number | string }[]): void {
    const value = (key: string) => values.find(item => item.id === key)?.value
    const status: JobHistoryStatus = { held: Number(value('held') ?? 0), more: value('more') === 1, loading: value('loading') === 1, unreachable: String(value('unreachable') ?? ''), open: Number(value('open') ?? 0) }
    const state = this.get(id)
    if (!state) return
    if (value('allUsersDenied') === 1 && state.filters.scope === 'all' && state.connectionId) {
      this.refuse(state.connectionId, { all: jobHistoryText.allUsersRefused })
      // As a manual switch to My jobs does: another user's expanded script or open details go with All users.
      this.bump(id, 'details')
      this.patch(id, { status, notice: { tone: 'info', text: jobHistoryText.allUsersDenied(), code: 'PERMISSION_DENIED' }, expanded: [], details: undefined })
      this.setFilters(id, { ...state.filters, scope: 'mine' })
      return
    }
    const before = state.status
    if (!before || before.held !== status.held || before.more !== status.more || before.loading !== status.loading || before.unreachable !== status.unreachable || before.open !== status.open) this.patch(id, { status })
  }

  private following(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      const connectionId = this.options.documents.get(state.id)?.connectionId
      if (connectionId !== state.connectionId) {
        const project = bigQueryProject(this.options.connections.getSnapshot().find(item => item.id === connectionId)) ?? state.project
        this.patch(state.id, { connectionId, project, selected: undefined, confirm: undefined, cancelling: [], details: undefined })
      } else if (!this.usable(state.id) && (state.confirm || state.cancelling.length)) this.patch(state.id, { confirm: undefined, cancelling: [] })
    }
    // Show in Job History waiting for its project's connection.
    if (this.pending.length) {
      const waiting = this.pending.filter(item => this.now() - item.at < jobHistoryPendingMs)
      this.pending = []
      // One that fails to open is reported once and dropped, without taking the others with it.
      let failure: unknown
      for (const item of waiting) {
        const connection = this.liveFor(item.project)
        if (!connection) { this.pending.push(item); continue }
        try { this.open(connection.id, item.jobs) } catch (error) { failure ??= error }
      }
      if (failure !== undefined) { this.publishContext(); throw failure }
    }
    this.publishContext()
  }

  /** How the document's view ended, when it failed: the document then shows why in place of its rows. */
  ended(id: string): JobHistoryEnd | undefined {
    const snapshot = this.handles.get(id)?.getSnapshot()
    if (snapshot?.status !== 'ended' || (snapshot.ended ? snapshot.ended.ended !== 'failed' : !snapshot.error)) return undefined
    const code = snapshot.ended?.code ?? snapshot.error?.code
    return { ...code ? { code } : {}, message: snapshot.ended?.message ?? snapshot.error?.message ?? jobHistoryText.failed }
  }
  refreshable(id: string): boolean {
    if (!this.usable(id)) return false
    const snapshot = this.handles.get(id)?.getSnapshot()
    return !!snapshot && (snapshot.status !== 'ended' || !!this.ended(id))
  }
  pausable(id: string): boolean { const status = this.handles.get(id)?.getSnapshot().status; return this.usable(id) && status !== undefined && status !== 'ended' }
  paused(id: string): boolean { return this.handles.get(id)?.getSnapshot().pausedBy === 'user' }

  // --- Filters ---------------------------------------------------------------------------------------------------------

  /** New filters: the backend lists again under them (a scope or range change re-lists; pinned jobs read each by id). */
  setFilters(id: string, filters: JobHistoryFilters): void {
    const state = this.get(id)
    if (!state) return
    // Every state, or every type, chosen is no filter at all.
    const next: JobHistoryFilters = { ...filters, states: filters.states.length === jobHistoryStates.length ? [] : filters.states, types: filters.types.length === jobHistoryTypes.length ? [] : filters.types }
    this.patch(id, { filters: next })
    this.sendArgs(id)
  }
  update(id: string, change: (filters: JobHistoryFilters) => JobHistoryFilters): void { const state = this.get(id); if (state) this.setFilters(id, change(state.filters)) }
  /** My jobs or All users; All users stays off once BigQuery refused it on the connection, and says why. */
  setScope(id: string, scope: 'mine' | 'all'): void {
    const state = this.get(id)
    if (!state || state.filters.scope === scope) return
    const refused = this.refused(id).all
    if (scope === 'all' && refused) { this.patch(id, { notice: { tone: 'info', text: refused, code: 'PERMISSION_DENIED' } }); return }
    // Rows of the other scope are other jobs: the scripts expanded and the details pane go with them (and any answer on its way).
    this.bump(id, 'details')
    this.patch(id, { expanded: [], details: undefined })
    this.setFilters(id, { ...state.filters, scope })
  }
  /** Clear filters: the default range, every state and type, no statement types, Varia or pinned jobs; the scope and filter box stay. */
  clearFilters(id: string): void { this.update(id, filters => ({ ...defaultJobHistoryFilters, scope: filters.scope })) }
  /** The filter box: the backend searches job id, user, destination and the SQL preview. */
  setText(id: string, text: string): void {
    const state = this.get(id)
    const trimmed = text.trim().slice(0, 128)
    if (!state || state.text === trimmed) return
    this.patch(id, { text: trimmed })
    this.handles.get(id)?.setProbe(jobHistoryProbe, { filter: trimmed ? { text: trimmed, columns: [...jobHistoryTextColumns] } : undefined })
  }
  /** Shows a script's statements under it in the grid, or hides them; at most jobHistoryLimits.expanded scripts at once. */
  toggleExpanded(id: string, job: HistoryJobRef): void {
    const state = this.get(id)
    if (!state) return
    const open = state.expanded.some(item => item.jobId === job.jobId)
    const expanded = open ? state.expanded.filter(item => item.jobId !== job.jobId) : [...state.expanded, job].slice(-jobHistoryLimits.expanded)
    this.patch(id, { expanded })
    this.sendArgs(id)
  }
  expanded(id: string, jobId: string): boolean { return !!this.get(id)?.expanded.some(item => item.jobId === jobId) }

  private sendArgs(id: string): void {
    const state = this.get(id), handle = this.handles.get(id)
    if (!state || !handle) return
    // Kept by the handle even with no stream open, so a view that subscribes again after a Reconnect sends what the filters say.
    handle.setArgs(jobHistoryArgs(state.filters, state.expanded, this.prices))
    if (!this.usable(id)) return
    // New args sample at once (after them: the view's updates go in order); a view with no open job would otherwise wait
    // out the source's idle interval before listing anew or reading a script's statements. An ended view starts again.
    handle.refresh()
  }

  // --- The grid and its selection ------------------------------------------------------------------------------------------

  attachGrid(id: string, grid: LiveGrid | undefined): void {
    this.grids.get(id)?.stop()
    this.grids.delete(id)
    if (!grid) {
      // No grid, no selection: the toolbar and the details pane stop acting on a row nobody can see.
      if (this.get(id)?.selected) this.patch(id, { selected: undefined })
      return
    }
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
    if (key === undefined || row === undefined || !table || !key) {
      if (current) this.patch(id, { selected: undefined })
      return
    }
    if (current?.jobId !== key) this.patch(id, { selected: { jobId: key, state: 'done', type: 'other', mine: false, hidden: false, children: 0, pending: true } })
    const read = ++entry.read
    entry.reading = table.handle.getWindow(row, 1, { colStart: 0, colEnd: columns.length, display: false }).then(window => {
      if (this.grids.get(id) !== entry || entry.read !== read || window.count < 1 || window.text[column.job] !== key) return
      const job = jobFromCells(window.text)!
      const before = this.get(id)?.selected
      if (!before || before.pending || JSON.stringify(before) !== JSON.stringify(job)) this.patch(id, { selected: job })
      // Another job, or the same one in a new state (it finished): its facts changed.
      const changed = this.get(id)?.details?.jobId !== key || !!before && !before.pending && before.jobId === key && before.state !== job.state
      if (this.get(id)?.detailsOpen && changed) void this.loadDetails(id)
    }, onUnexpectedError)
  }
  /** The selected job once its cells are read; undefined when none is selected or the document cannot act. */
  private async selectedJob(id: string): Promise<SelectedJob | undefined> {
    await this.grids.get(id)?.reading
    const job = this.get(id)?.selected
    return job && !job.pending && this.usable(id) ? job : undefined
  }
  /** The job a row action acts on: the pressed row's when its menu was opened on a row other than the active one (a
   *  right-click inside a multi-row selection keeps the selection), else the selected job. */
  private async jobFor(id: string, row?: number): Promise<SelectedJob | undefined> {
    const entry = this.grids.get(id), snapshot = entry?.grid.getSnapshot()
    if (row === undefined || !entry || snapshot?.selection?.active.row === row) return this.selectedJob(id)
    const table = snapshot?.table
    if (!table || !Number.isSafeInteger(row) || row < 0) return undefined
    let window: Awaited<ReturnType<typeof table.handle.getWindow>>
    try { window = await table.handle.getWindow(row, 1, { colStart: 0, colEnd: columns.length, display: false }) } catch { return undefined }
    if (this.grids.get(id) !== entry || window.count < 1 || !this.usable(id)) return undefined
    return jobFromCells(window.text)
  }
  /** Whether an action applies to the selected job now, and why not (the menus' and the details pane's tooltips). */
  actionState(id: string, action: JobHistoryAction): { enabled: boolean; reason?: string } {
    const state = this.get(id), job = state?.selected
    if (!state || !job) return { enabled: false, reason: 'Select a job.' }
    if (!this.usable(id)) return { enabled: false, reason: jobHistoryText.notConnected }
    if (job.pending) return { enabled: true }
    if (action === 'cancel' && state.cancelling.includes(job.jobId)) return { enabled: false, reason: 'A cancel is on its way.' }
    return jobHistoryActionState(action, job, this.refused(id))
  }

  // --- Details ---------------------------------------------------------------------------------------------------------------

  /** Details (Enter): opens the pane on the selected job, or closes it. */
  async toggleDetails(id: string): Promise<void> {
    const state = this.get(id)
    if (!state) return
    if (state.detailsOpen) { this.patch(id, { detailsOpen: false }); return }
    this.patch(id, { detailsOpen: true })
    await this.loadDetails(id)
  }
  closeDetails(id: string): void { if (this.get(id)?.detailsOpen) { this.patch(id, { detailsOpen: false }); this.options.focus?.(id) } }
  /** Reads the selected job with bigquery.jobs.get. Another user's job without bigquery.jobs.get is refused once, remembered
   *  for the connection, and its pane shows the listed fields with "details hidden by BigQuery" from then on. */
  async loadDetails(id: string): Promise<void> {
    const job = await this.selectedJob(id)
    const state = this.get(id)
    if (!job || !state?.connectionId) {
      // A job is selected but the document cannot read it (its connection is gone): say so rather than "Loading the job…".
      const selected = state?.selected
      if (state?.detailsOpen && selected && !selected.pending) {
        // A new generation, so an earlier job's answer still on its way cannot replace this.
        this.bump(id, 'details')
        this.patch(id, { details: { jobId: selected.jobId, loading: false, error: { message: jobHistoryText.notConnected } } })
      }
      return
    }
    if (!job.mine && this.refused(id).get) {
      this.bump(id, 'details')
      this.patch(id, { details: { jobId: job.jobId, loading: false, error: { message: this.refused(id).get!, code: 'PERMISSION_DENIED' } } })
      return
    }
    const generation = this.bump(id, 'details'), connectionId = state.connectionId
    this.patch(id, { details: { jobId: job.jobId, loading: true } })
    const result = await this.request(() => this.options.api.bigQueryJob({ connectionId, jobId: job.jobId, ...job.location ? { location: job.location } : {}, ...job.mine ? {} : { allUsers: true } }))
    if (!this.current(id, 'details', generation, connectionId)) return
    if (result.ok) { this.patch(id, { details: { jobId: job.jobId, loading: false, value: result.value } }); return }
    if (result.code === 'PERMISSION_DENIED' && !job.mine) this.refuse(connectionId, { get: jobHistoryText.getDenied(result.error) })
    this.patch(id, { details: { jobId: job.jobId, loading: false, error: { message: result.code === 'PERMISSION_DENIED' && !job.mine ? jobHistoryText.getDenied(result.error) : result.error, ...result.code ? { code: result.code } : {} } } })
  }

  // --- Actions ---------------------------------------------------------------------------------------------------------------

  /** Open Results (a finished query job of the principal's) or Re-attach (a running one): a tab already holding the job is
   *  focused; otherwise a new query tab on the connection attaches to it through query.attach. Open Results does not take
   *  over the job's session, which another tab may still use; Re-attach does, so the session ends with the new tab. */
  async attach(id: string, action: 'openResults' | 'reattach', row?: number): Promise<void> {
    const job = await this.jobFor(id, row)
    const state = this.get(id)
    if (!job || !state?.connectionId) return
    const allowed = jobHistoryActionState(action, job, this.refused(id))
    if (!allowed.enabled) { this.patch(id, { notice: { tone: 'info', text: allowed.reason! } }); return }
    const holder = this.options.queries.tabHoldingJob(job.jobId, state.project)
    if (holder) { this.options.documents.activate(holder); return }
    // Open Results holds the job's SQL (jobs.get, free), with the default dataset it ran with: when BigQuery no longer keeps
    // the result, Execute in that tab runs it again (docs/bigquery.md, Job History). Without it, an empty tab and no default
    // dataset (else the new tab takes the active document's: Job History's own is the project).
    let sql = '', dataset = ''
    if (action === 'openResults') {
      const connectionId = state.connectionId, generation = this.bump(id, 'action')
      const known = state.details?.jobId === job.jobId ? state.details.value : undefined
      const details = known ? { ok: true as const, value: known } : await this.request(() => this.options.api.bigQueryJob({ connectionId, jobId: job.jobId, ...job.location ? { location: job.location } : {} }))
      if (!this.current(id, 'action', generation, connectionId)) return
      // A tab may have opened the job while jobs.get answered.
      const opened = this.options.queries.tabHoldingJob(job.jobId, state.project)
      if (opened) { this.options.documents.activate(opened); return }
      if (details?.ok && details.value.job.sql && !details.value.job.sqlTruncated) {
        sql = details.value.job.sql
        dataset = details.value.job.dataset?.startsWith(state.project + '.') ? details.value.job.dataset.slice(state.project.length + 1) : ''
      }
    }
    const tab = this.options.documents.newQuery(sql, undefined, state.connectionId, dataset)
    this.options.queries.restoreJobs(tab.id, [{
      jobId: job.jobId, project: state.project, ...job.location ? { location: job.location } : {}, state: action === 'reattach' ? 'running' : 'done',
      transaction: 'unknown', createdAt: job.createdAt ?? this.now(), ...action === 'openResults' ? { adopt: false as const } : {}
    }])
  }
  /** Open SQL in New Tab, or Re-run (Execute in that tab, so the cost rules apply as to any query): the job's whole SQL.
   *  Re-run of a statement that may change table data, or of another user's job, asks first, naming the job. */
  async openSql(id: string, run: boolean, row?: number): Promise<void> {
    const job = await this.jobFor(id, row)
    const state = this.get(id)
    if (!job || !state?.connectionId) return
    const allowed = jobHistoryActionState(run ? 'rerun' : 'openSql', job, this.refused(id))
    if (!allowed.enabled) { this.patch(id, { notice: { tone: 'info', text: allowed.reason! } }); return }
    if (run && rerunAsks(job)) {
      this.patch(id, { confirm: { action: 'rerun', job, question: rerunQuestion(job, job.createdAt !== undefined ? agoText(job.createdAt, this.now()) : undefined) }, notice: undefined })
      return
    }
    await this.sql(id, job, run)
  }
  private async sql(id: string, job: SelectedJob, run: boolean): Promise<void> {
    const state = this.get(id)
    if (!state?.connectionId || !this.usable(id)) return
    const connectionId = state.connectionId, generation = this.bump(id, 'action')
    const known = state.details?.jobId === job.jobId ? state.details.value : undefined
    const details = known ? { ok: true as const, value: known } : await this.request(() => this.options.api.bigQueryJob({ connectionId, jobId: job.jobId, ...job.location ? { location: job.location } : {}, ...job.mine ? {} : { allUsers: true } }))
    if (!this.current(id, 'action', generation, connectionId)) return
    if (!details.ok) {
      if (details.code === 'PERMISSION_DENIED' && !job.mine) this.refuse(connectionId, { get: jobHistoryText.getDenied(details.error) })
      this.patch(id, { notice: { tone: 'error', text: details.code === 'PERMISSION_DENIED' && !job.mine ? jobHistoryText.getDenied(details.error) : details.error, ...details.code ? { code: details.code } : {} } })
      return
    }
    const sql = details.value.job.sql
    if (!sql) { this.patch(id, { notice: { tone: 'info', text: jobHistoryText.noSql } }); return }
    // The job's own default dataset when it is in this project, so its unqualified names resolve as they did; else none.
    const dataset = details.value.job.dataset?.startsWith(state.project + '.') ? details.value.job.dataset.slice(state.project.length + 1) : ''
    const tab = this.options.documents.newQuery(sql, undefined, connectionId, dataset)
    if (details.value.job.sqlTruncated) this.patch(id, { notice: { tone: 'info', text: jobHistoryText.sqlTruncated } })
    // The cost prompts name the job they would run again.
    else if (run) void this.options.queries.execute(tab.id, undefined, job.jobId).catch(onUnexpectedError)
  }
  /** Cancel Job on the selected (or pressed) job, once its cells are read: always asks first (it names the job, its user and
   *  its age). */
  async requestCancel(id: string, row?: number): Promise<void> {
    const job = await this.jobFor(id, row)
    const state = this.get(id)
    if (!job || !state || state.cancelling.includes(job.jobId)) return
    const allowed = jobHistoryActionState('cancel', job, this.refused(id))
    if (!allowed.enabled) { this.patch(id, { notice: { tone: 'info', text: allowed.reason! } }); return }
    this.patch(id, { confirm: { action: 'cancel', job, question: cancelQuestion(job, job.createdAt !== undefined ? agoText(job.createdAt, this.now()) : undefined) }, notice: undefined })
  }
  /** The answer to the question Cancel Job or Re-run asked: `proceed` cancels the job, or opens and runs its SQL. */
  answerConfirm(id: string, proceed: boolean): void {
    const confirm = this.get(id)?.confirm
    if (!confirm) return
    this.patch(id, { confirm: undefined })
    if (proceed) void (confirm.action === 'cancel' ? this.cancel(id, confirm.job) : this.sql(id, confirm.job, true)).catch(onUnexpectedError)
    this.options.focus?.(id)
  }
  private async cancel(id: string, job: SelectedJob): Promise<void> {
    const state = this.get(id)
    if (!state?.connectionId || !this.usable(id) || state.cancelling.includes(job.jobId)) return
    const connectionId = state.connectionId
    this.patch(id, { cancelling: [...state.cancelling, job.jobId], notice: undefined })
    const result = await this.request(() => this.options.api.bigQueryCancelJob({ connectionId, jobId: job.jobId, ...job.location ? { location: job.location } : {} }))
    const now = this.get(id)
    if (!now || now.connectionId !== connectionId) return
    if (!result.ok && result.code === 'PERMISSION_DENIED' && !job.mine) this.refuse(connectionId, { cancel: jobHistoryText.cancelDenied(result.error) })
    this.patch(id, { cancelling: now.cancelling.filter(item => item !== job.jobId), notice: cancelNotice(job, result) })
    // The row turns Cancelled on its own from the live view; reading it now shows the change at once.
    if (result.ok) this.handles.get(id)?.refresh()
  }
  /** Copy Job ID (project:LOCATION.job_id) or Copy Console Link, as text. */
  async copy(id: string, what: 'id' | 'link', row?: number): Promise<void> {
    const job = await this.jobFor(id, row)
    const state = this.get(id)
    if (!job || !state) return
    const text = what === 'id' ? qualifiedJobId(state.project, job.jobId, job.location) : consoleJobLink(state.project, job.jobId, job.location)
    const result = await this.request(() => this.options.api.writeClipboardText(text))
    if (!this.get(id)) return
    this.patch(id, { notice: result.ok ? { tone: 'info', text: jobHistoryText.copied(what === 'id' ? 'the job ID' : 'the console link') } : { tone: 'error', text: jobHistoryText.copyFailed(result.error), code: result.code } })
  }
  refresh(id: string): void { if (this.refreshable(id)) this.handles.get(id)?.refresh() }
  togglePause(id: string): void { const handle = this.handles.get(id); if (handle && this.pausable(id)) handle.setUserPaused(!this.paused(id)) }
  dismissNotice(id: string): void { if (this.get(id)?.notice) this.patch(id, { notice: undefined }) }

  /** Whether the document's connection is live and still the one it was opened on (or followed to). */
  usable(id: string): boolean {
    const connectionId = this.get(id)?.connectionId
    return this.targetBindings.matchesConnection(id, connectionId) && live(this.options.connections.getSnapshot().find(connection => connection.id === connectionId))
  }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------

  save(): Promise<boolean> { return Promise.resolve(true) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  /** A cancel the user confirmed still goes through when its document closes: only its answer is dropped. */
  closed(id: string): void {
    this.targetBindings.forget(id)
    this.generations.delete(`details:${id}`)
    this.generations.delete(`action:${id}`)
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
    for (const id of Object.keys(this.getSnapshot().documents)) this.closed(id)
    this.disposed = true
    this.pending = []
    this.targetBindings.clear()
    this.registration.dispose()
    this.stopFollowing()
    this.stopSettings()
    this.clearListeners()
    this.contextStore.clear()
  }

  // --- Internals ---------------------------------------------------------------------------------------------------------

  private liveFor(project: string): LiveConnection | undefined { return this.options.connections.getSnapshot().find(item => live(item) && bigQueryProject(item) === project) }
  private refuse(connectionId: string, refusal: JobHistoryRefusals): void { this.refusals.set(connectionId, { ...this.refusals.get(connectionId), ...refusal }); this.publishContext() }
  /** Details and actions count apart: an Open SQL does not drop the details pane's answer, nor a new selection an Open SQL. */
  private bump(id: string, kind: 'details' | 'action'): number { const key = `${kind}:${id}`, next = (this.generations.get(key) ?? 0) + 1; this.generations.set(key, next); return next }
  /** An answer still applies: its document is open, no later request of the same document replaced it, and it is on the same connection. */
  private current(id: string, kind: 'details' | 'action', generation: number, connectionId: string): boolean { return this.generations.get(`${kind}:${id}`) === generation && this.get(id)?.connectionId === connectionId }
  private async request<T>(send: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    try { return await send() } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : String(failure), code: 'BACKEND_ERROR' } }
  }
  private patch(id: string, patch: Partial<JobHistoryState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as JobHistoryState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: JobHistoryState): void {
    this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } })
    this.publishContext()
  }
  private publishContext(): void {
    const byDocument: Record<string, JobHistoryKeys> = {}
    for (const state of Object.values(this.getSnapshot().documents)) {
      const id = state.id
      byDocument[id] = { paused: this.paused(id), refreshable: this.refreshable(id), pausable: this.pausable(id), ...actionKeys(state.selected, this.refused(id), state.cancelling, this.usable(id)) }
    }
    const current = this.contextStore.getSnapshot().byDocument
    const same = Object.keys(byDocument).length === Object.keys(current).length
      && Object.entries(byDocument).every(([id, keys]) => (Object.keys(keys) as (keyof JobHistoryKeys)[]).every(key => current[id]?.[key] === keys[key]))
    if (!same) this.contextStore.set({ byDocument })
  }
}

/** A state's label in the grid, for tests and the details pane. */
export const stateLabel = (state: JobState): string => jobHistoryStateLabels[state]
