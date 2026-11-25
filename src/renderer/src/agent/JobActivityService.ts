// SQL Server Agent's Job Activity Monitor (AG-3, docs/sql-server-agent.md): one document per connection showing every job
// msdb lets the login see, live. The backend reads and filters the jobs (the agent.jobs source); this service owns each
// document's view chip, filter box and column value filters, the expanded job whose last run shows in place, the grid's kept
// state and selection, the tiles' counts, Agent's state from the service probe, and the bulk verbs (Start, Stop, Enable,
// Disable), which send one AG-2 job verb per selected job, one after another, each with its own result line. Change owner and Attach
// schedule (AG-3b) first ask for a login or a shared schedule in a form below the bulk bar, then go the same way. Failures are values
// in the snapshot; nothing throws into React.
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ActionExecuteResult } from '../../../shared/actions/schema'
import type { AgentSchedulesModel } from '../../../shared/actions/agent-schedule'
import { agentBulkText, attachPlan, ownerPlan, ownerUnavailable, type BulkJobPlan } from '../../../shared/agent/bulk'
import { agentLimits } from '../../../shared/agent/catalog'
import {
  agentAvailability, agentBanner, agentBulkTitles, agentJobFilterLimits, agentJobTextColumns, agentJobsProbe, agentJobsSource, agentServiceProbe, bulkUnavailable, jobActivityTabName,
  type AgentAvailability, type AgentBulkFormVerb, type AgentBulkVerb, type AgentJobColumnFilter, type AgentJobsArgs, type AgentJobView, type AgentServiceSample
} from '../../../shared/agent/jobs'
import { liveProbes } from '../../../shared/live/catalog'
import { actionContextValues, actionMenuReasons, actionMenuState } from '../../../shared/actions/catalog'
import type { CommandArgs } from '../core/types'
import type { AgentLongRunSource, ExplorerService } from '../explorer/ExplorerService'
import { isAgentServiceAction } from '../../../shared/actions/catalog'
import type { LiveFacet } from '../../../shared/live/schema'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import { blockRange, type GridSelection } from '../grid/selection'
import type { LiveGrid, LiveGridState } from '../live/LiveGrid'
import { documentOwner, type LiveHandle, type LiveProbeSnapshot, type LiveService } from '../live/LiveService'
import type { LiveConnection } from '../services/connections'
import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import type { EditorGroupService } from '../services/editor-groups'
import type { PaneService } from '../services/panes'

/** The list's stored columns the service reads back from a selected row (catalogue order, src/shared/live/catalog.ts). */
const columnIndex = Object.fromEntries(liveProbes[agentJobsProbe].tables![0].columns.map((column, index) => [column.id, index])) as Record<string, number>
const readColumns = columnIndex.jobId + 1

/** A job selected in the grid, as its cells read: what a bulk verb sends (its name and the identity msdb listed) and shows. */
export interface SelectedJob {
  readonly id: string
  readonly name: string
  readonly status: string
  /** Its last run's start as the grid shows it (yyyy-MM-dd HH:mm:ss, server time), or '' when it never ran. */
  readonly lastRun: string
  /** Its owner as the grid shows it ('' where msdb hides the login); Change owner skips a job that already has the one chosen. */
  readonly owner?: string
}
export type BulkLineState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'
export interface BulkLine { readonly id: string; readonly name: string; readonly state: BulkLineState; readonly message?: string }
/** A bulk verb's run: one line per job, in the order they go; Stop sends no more after the one on its way. */
export interface BulkRun { readonly verb: BulkRunVerb; readonly lines: readonly BulkLine[]; readonly running: boolean; readonly stopping: boolean }
export type BulkRunVerb = AgentBulkVerb | AgentBulkFormVerb
/** Change owner's or Attach schedule's form (AG-3b): the jobs selected when it opened, what its read found, and the value chosen. */
interface BulkFormBase { readonly key: string; readonly jobs: readonly SelectedJob[]; readonly state: 'loading' | 'ready' | 'failed'; readonly error?: string }
export interface OwnerForm extends BulkFormBase { readonly verb: 'changeOwner'; readonly owner: string; readonly sysadmin?: boolean; readonly owners?: readonly string[] }
export interface ScheduleForm extends BulkFormBase { readonly verb: 'attachSchedule'; readonly search: string; readonly picked?: number; readonly model?: AgentSchedulesModel }
export type BulkForm = OwnerForm | ScheduleForm

export interface JobActivityState {
  readonly id: string
  readonly connectionId?: string
  readonly server: string
  readonly label: string
  readonly linux: boolean
  readonly view: AgentJobView
  readonly text: string
  readonly columnFilters: readonly AgentJobColumnFilter[]
  /** The job whose last run shows below the grid (the rethink's chevron), by id, with its name for the panel's title. */
  readonly expanded?: { readonly id: string; readonly name: string }
  /** The expanded job changed and no list sample has come since: the last run table is still another job's (or none). */
  readonly lastRunPending?: boolean
  readonly selected: readonly SelectedJob[]
  /** The selection holds more rows than a bulk verb may take (agentLimits.startJobs): only that many were read. */
  readonly overCap: boolean
  readonly bulk?: BulkRun
  readonly form?: BulkForm
  /** The tiles' counts from the last list sample, in the probe's series order (null where none yet). */
  readonly counts?: readonly (number | null)[]
  readonly service?: AgentServiceSample
  readonly facets: Readonly<Record<string, LiveFacet>>
}
export interface JobActivitySnapshot { readonly documents: Readonly<Record<string, JobActivityState>> }

/** How the document's view ended by failing (a login msdb refuses, PERMISSION_DENIED; Agent XPs off at open, AGENT_DISABLED). */
export interface JobActivityEnd { readonly code?: string; readonly message: string; readonly denied: boolean }

export interface JobActivityServiceOptions extends CustomDocumentTargetOptions {
  /** The Agent node's service verbs (AG-10): Start in the Agent-stopped banner runs explorer.startAgent on this node. */
  readonly explorer?: Pick<ExplorerService, 'agentMenuNode'>
  /** The long-run registry: a start, stop or restart of Agent ending on a monitor's connection reads it again at once (AG-10). */
  readonly longRuns?: AgentLongRunSource
  readonly api: Pick<VariaApi, 'executeObjectAction' | 'describeObject'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot' | 'subscribe'>
  readonly panes: Pick<PaneService, 'getSnapshot' | 'subscribe'>
  readonly groups?: Pick<EditorGroupService, 'getSnapshot' | 'subscribe'>
  readonly live: Pick<LiveService, 'open'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  /** A Start that went through: the status bar follows the job from here (AgentJobStatusService.watch). */
  readonly started?: (connectionId: string, job: SelectedJob, sentAt: number) => void
  readonly focus?: (id: string) => void
  readonly newId?: () => string
}

export const jobActivityText = {
  denied: "This login cannot read SQL Server Agent's jobs: msdb grants them to sysadmin and to members of SQLAgentUserRole, SQLAgentReaderRole and SQLAgentOperatorRole.",
  failed: 'Job Activity Monitor stopped reading the jobs.',
  bulkDone: (verb: BulkRunVerb, done: number, total: number) => `${agentBulkTitles[verb].line}: ${done} of ${total} ${total === 1 ? 'job' : 'jobs'} done.`,
  lineDone: { startJob: 'Start requested', stopJob: 'Stop requested', enable: 'Enabled', disable: 'Disabled', changeOwner: 'Owner changed', attachSchedule: 'Attached' } satisfies { readonly [V in BulkRunVerb]: string },
  skipped: 'Not sent: Stop',
  lost: 'The connection closed; the outcome is unknown.'
} as const

/** The args a document's state sends: only what applies. */
export function jobActivityArgs(state: Pick<JobActivityState, 'expanded' | 'columnFilters'>): AgentJobsArgs {
  // Only filters both schemas accept: one that names something, and an excluding one only with values and without (Non-blanks).
  const filters = state.columnFilters.filter(filter => (filter.values?.length || filter.blanks || filter.nonBlanks) && !(filter.exclude && (!filter.values?.length || filter.nonBlanks))).map(filter => ({
    ...filter, ...filter.values ? { values: filter.values.slice(0, agentJobFilterLimits.values).map(value => value.slice(0, agentJobFilterLimits.chars)) } : {}
  }))
  return { ...state.expanded ? { expand: state.expanded.id } : {}, ...filters.length ? { filters } : {} }
}
/** How many filters Clear filters clears: the view chip, the filter box and each column's. */
export const activeFilters = (state: Pick<JobActivityState, 'view' | 'text' | 'columnFilters'>): number => (state.view === 'all' ? 0 : 1) + (state.text.trim() ? 1 : 0) + state.columnFilters.length

/** What the list probe's state says about the document: a failure of the list itself (an error naming no table: one beside a
 *  sample names the part it left empty, the elapsed times or the last run; AGENT_DISABLED the banner explains), whether the rows
 *  are stale, and why the last run could not be read. */
export function listProblems(probe: LiveProbeSnapshot | undefined): { readonly failure?: { readonly code?: string; readonly message: string }; readonly stale: boolean; readonly lastRun?: string } {
  const error = probe?.error
  const list = !!error && !error.tables
  const failure = list && error.code !== 'AGENT_DISABLED' && (probe.state === 'failing' || probe.state === 'stale') ? { code: error.code, message: error.message } : undefined
  return { ...failure ? { failure } : {}, stale: probe?.state === 'stale' || (probe?.state === 'failing' && list), ...error?.tables?.includes(1) ? { lastRun: error.message } : {} }
}

/** What the header's pill says in place of the interval while the rows are not current: no access, or Agent unusable. */
export function pillNote(availability: AgentAvailability, end: JobActivityEnd | undefined): string | undefined {
  if (end?.denied) return 'No access'
  return availability === 'stopped' || availability === 'xpsOff' || availability === 'unknown' ? 'Agent unavailable' : undefined
}

/** A result line's words for one job's verb. */
export function bulkLine(verb: BulkRunVerb, result: ApiResult<ActionExecuteResult> | undefined, thrown?: unknown): Pick<BulkLine, 'state' | 'message'> {
  if (thrown !== undefined) return { state: 'failed', message: thrown instanceof Error ? thrown.message : String(thrown) }
  if (!result) return { state: 'failed', message: jobActivityText.lost }
  if (!result.ok) return { state: 'failed', message: result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? jobActivityText.lost : result.error }
  if (result.value.error) return { state: 'failed', message: result.value.error.message }
  return { state: 'done', message: jobActivityText.lineDone[verb] }
}

/** The rows a selection holds, in order, at most `cap` (a bulk verb's limit plus one, to know the limit is passed). */
export function selectionRows(selection: GridSelection, rows: number, columns: number, cap: number): number[] {
  const set = new Set<number>()
  for (const block of selection.blocks) {
    const range = blockRange(block, rows, columns)
    for (let row = range.top; row <= range.bottom && set.size < cap; row++) set.add(row)
    if (set.size >= cap) break
  }
  if (set.size < cap && selection.active.row >= 0 && selection.active.row < rows) set.add(selection.active.row)
  return [...set].sort((a, b) => a - b)
}

/**
 * The Job Activity Monitor documents (custom document kind 'agentJobActivity'), one per connection: the Agent node's and the
 * Job Activity Monitor node's menus and the palette open it, or show the open one.
 */
export class JobActivityService extends SnapshotStore<JobActivitySnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'agentJobActivity' as const
  readonly saves = false
  readonly inSaveAll = false
  private readonly newId: () => string
  private readonly registration: Disposable
  private readonly stopFollowing: () => void
  private readonly handles = new Map<string, LiveHandle>()
  private readonly gridStates = new Map<string, LiveGridState>()
  private readonly grids = new Map<string, { readonly grid: LiveGrid; readonly stop: () => void; read: number; reading?: Promise<void> }>()
  private readonly watches = new Map<string, () => void>()
  private readonly targetBindings: CustomDocumentTargets
  private disposed = false

  constructor(private readonly options: JobActivityServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.registration = options.documents.registerProvider(this)
    const follow = () => { try { this.following() } catch (failure) { onUnexpectedError(failure) } }
    const stopDocuments = options.documents.subscribe(follow), stopConnections = options.connections.subscribe(follow)
    let running = this.agentRuns()
    const stopRuns = options.longRuns?.subscribe(() => {
      const now = this.agentRuns()
      const ended = [...running].filter(connectionId => !now.has(connectionId))
      running = now
      for (const state of Object.values(this.getSnapshot().documents)) if (state.connectionId && ended.includes(state.connectionId)) this.refresh(state.id)
    })
    this.stopFollowing = () => { stopDocuments(); stopConnections(); stopRuns?.() }
  }
  /** The connections a start, stop or restart of Agent runs on now. */
  private agentRuns(): Set<string> {
    return new Set((this.options.longRuns?.getSnapshot().runs ?? []).filter(run => isAgentServiceAction(run.kind)).map(run => run.connectionId))
  }

  get(id: string | undefined): JobActivityState | undefined { return id === undefined ? undefined : this.getSnapshot().documents[id] }
  handle(id: string): LiveHandle | undefined { return this.handles.get(id) }
  gridState(id: string): LiveGridState {
    let state = this.gridStates.get(id)
    if (!state) this.gridStates.set(id, state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false })
    return state
  }
  /** Agent's state for a document, by its service probe's last sample. */
  availability(id: string): AgentAvailability { return agentAvailability(this.get(id)?.service) }
  /** While the expanded job's last run is unread, what the panel says in place of table 1 (another job's, or none). */
  lastRunWaiting(id: string): { readonly text: string; readonly failed: boolean } | undefined {
    if (!this.get(id)?.lastRunPending) return undefined
    if (!this.live(id)) return { text: 'The last run is read when the server is connected again.', failed: false }
    // The list failing whole reads no last run: say so rather than reading forever.
    const error = this.handles.get(id)?.getSnapshot().probes[agentJobsProbe]?.error
    if (error && !error.tables?.length) return { text: error.code === 'AGENT_DISABLED' ? 'The last run is read once SQL Server Agent can run jobs again.' : `The last run could not be read: ${error.message}`, failed: true }
    return { text: 'Reading the last run…', failed: false }
  }
  /** What the banner and pill show: a lost connection's last service reading is no news, so they wait (pending) for a live one. */
  shownAvailability(id: string): AgentAvailability { return this.live(id) ? this.availability(id) : 'pending' }
  /** Whether the Agent-stopped banner offers Start (Agent stopped, its service not Disabled): only then does the monitor follow the
   *  Agent node's verb, so the tree's and the status's publishes cost a running monitor nothing. */
  startAgentOffered(id: string): boolean {
    const state = this.get(id)
    return !!state && agentBanner(this.shownAvailability(id), state.service, true, state.linux)?.start === true
  }
  /**
   * What Start Agent in the Agent-stopped banner runs (AG-10): explorer.startAgent on the connection's Agent node (the tree's row, or the
   * object with the same facts), with the monitor's own service reading where the tree has none, and why the verb is greyed (Varia off
   * Windows, a Linux server, Managed Instance, a cluster, a start or stop already running, a Disabled service); undefined without a server.
   */
  startAgentTarget(id: string): { readonly args: CommandArgs; readonly reason?: string } | undefined {
    const state = this.get(id)
    if (!state?.connectionId || !this.live(id)) return undefined
    const node = this.options.explorer?.agentMenuNode(state.connectionId, { ...state.service?.serviceState !== undefined ? { state: state.service.serviceState } : {}, ...state.service?.startupType !== undefined ? { startup: state.service.startupType } : {}, ...state.service?.clustered === 1 ? { clustered: true } : {} })
    if (!node) return undefined
    const reason = actionMenuReasons(node).startAgent
    // The verb's precondition reads the selection's action keys: the node's stand in for them, as a Search Objects result's do.
    return { args: { target: { kind: 'explorer', node }, state: actionContextValues(actionMenuState(node)) }, ...reason ? { reason } : {} }
  }

  // --- Opening ---------------------------------------------------------------------------------------------------------

  open(connectionId: string): string {
    if (this.disposed) throw new Error('Job Activity Monitor is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!connection) throw new Error('Connect to the server first.')
    const existing = Object.values(this.getSnapshot().documents).find(state => state.connectionId === connectionId)
    if (existing) { this.options.documents.activate(existing.id); return existing.id }
    const label = connection.displayName || connection.server
    const document = this.options.documents.openCustom('agentJobActivity', jobActivityTabName(label), connection.id, 'msdb')
    this.targetBindings.bind(document.id, connection.id)
    const state: JobActivityState = {
      id: document.id, connectionId: connection.id, server: connection.server, label, linux: !!connection.linux, view: 'all', text: '', columnFilters: [], selected: [], overCap: false, facets: {}
    }
    this.put(state)
    this.subscribeLive(state)
    return document.id
  }

  private subscribeLive(state: JobActivityState): void {
    const owner = documentOwner(state.id, this.options.documents, this.options.panes, this.options.groups)
    const handle = this.options.live.open({
      connectionId: state.connectionId!, source: agentJobsSource, args: jobActivityArgs(state),
      probes: [{ probe: agentJobsProbe, intervalMs: liveProbes[agentJobsProbe].intervalMs.default }, { probe: agentServiceProbe, intervalMs: liveProbes[agentServiceProbe].intervalMs.default }]
    }, { ...owner, connectionId: () => this.live(state.id) ? this.options.documents.get(state.id)?.connectionId : undefined })
    this.handles.set(state.id, handle)
    const ticks = handle.onTick(({ tick }) => {
      let patch: Partial<JobActivityState> = {}
      for (const sample of tick.samples) {
        if (sample.probe === agentJobsProbe) {
          // A real read only: a resorted sample re-sends the rows held from before the expand change.
          if (!sample.resorted && this.get(state.id)?.lastRunPending) patch = { ...patch, lastRunPending: false }
          if (sample.metrics) patch = { ...patch, counts: [...sample.metrics] }
          const facets = sample.tables?.find(table => table.table === 0)?.facets
          if (facets?.length) patch = { ...patch, facets: { ...this.get(state.id)?.facets, ...patch.facets, ...Object.fromEntries(facets.map(facet => [facet.column, facet])) } }
        }
        if (sample.probe === agentServiceProbe && sample.status) {
          // Every service sample carries what it read; a value left out is unknown, so the sample replaces the last whole.
          const value = (id: string) => { const entry = sample.status!.find(item => item.id === id); return typeof entry?.value === 'number' ? entry.value : undefined }
          const service: AgentServiceSample = { agentXps: value('agentXps'), serviceState: value('serviceState'), startupType: value('startupType'), clustered: value('clustered') }
          const before = this.get(state.id)?.service
          if (before?.agentXps !== service.agentXps || before?.serviceState !== service.serviceState || before?.startupType !== service.startupType || before?.clustered !== service.clustered) patch = { ...patch, service }
          // Agent usable while the list stopped on AGENT_DISABLED (it may have restarted between two service samples): read again
          // so the list resumes by itself.
          if (agentAvailability(service) === 'running' && handle.getSnapshot().probes[agentJobsProbe]?.error?.code === 'AGENT_DISABLED') handle.refresh()
        }
      }
      if (Object.keys(patch).length) this.patch(state.id, patch)
    })
    this.watches.set(state.id, () => ticks.dispose())
  }

  private following(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      const connectionId = this.options.documents.get(state.id)?.connectionId
      if (connectionId !== state.connectionId) this.patch(state.id, { connectionId, selected: [], overCap: false, form: undefined })
    }
  }

  /** How the view ended, when it failed: the document then says why in place of its rows. */
  ended(id: string): JobActivityEnd | undefined {
    const snapshot = this.handles.get(id)?.getSnapshot()
    // msdb refusing the list stops only that probe (the service probe needs no permission), so the view itself stays live.
    const list = snapshot?.probes[agentJobsProbe]?.error
    if (snapshot?.status !== 'ended' && list?.code === 'PERMISSION_DENIED' && !list.tables) return { code: list.code, message: jobActivityText.denied, denied: true }
    if (snapshot?.status !== 'ended' || (snapshot.ended ? snapshot.ended.ended !== 'failed' : !snapshot.error)) return undefined
    const code = snapshot.ended?.code ?? snapshot.error?.code
    const denied = code === 'PERMISSION_DENIED'
    return { ...code ? { code } : {}, message: denied ? jobActivityText.denied : snapshot.ended?.message ?? snapshot.error?.message ?? jobActivityText.failed, denied }
  }

  // --- View, filters and the expanded job --------------------------------------------------------------------------------

  setView(id: string, view: AgentJobView): void {
    const state = this.get(id)
    if (!state || state.view === view) return
    this.patch(id, { view })
    this.handles.get(id)?.setProbe(agentJobsProbe, { view: view === 'all' ? undefined : view })
  }
  setText(id: string, text: string): void {
    const state = this.get(id)
    if (!state || state.text === text) return
    this.patch(id, { text })
    const trimmed = text.trim()
    this.handles.get(id)?.setProbe(agentJobsProbe, { filter: trimmed ? { text: trimmed.slice(0, 128), columns: [...agentJobTextColumns] } : undefined })
  }
  setColumnFilter(id: string, column: AgentJobColumnFilter['column'], filter: { readonly values?: readonly string[]; readonly blanks?: boolean; readonly nonBlanks?: boolean; readonly exclude?: boolean } | undefined): void {
    const state = this.get(id)
    if (!state) return
    const others = state.columnFilters.filter(item => item.column !== column)
    const { values, ...flags } = filter ?? {}
    this.setState(id, { columnFilters: filter ? [...others, { column, ...flags, ...values ? { values: [...values] } : {} }] : others })
  }
  /** A tile pressed: its view chip, or Between retries' Status filter; pressed again, back to All (or that filter off). */
  applyTile(id: string, applies: { readonly view: Exclude<AgentJobView, 'all'> } | { readonly status: string }): void {
    const state = this.get(id)
    if (!state) return
    if ('view' in applies) { this.setView(id, state.view === applies.view ? 'all' : applies.view); return }
    const current = state.columnFilters.find(filter => filter.column === 'status')
    const on = current?.values?.length === 1 && current.values[0] === applies.status && !current.exclude
    this.setColumnFilter(id, 'status', on ? undefined : { values: [applies.status] })
  }
  tilePressed(id: string, applies: { readonly view: Exclude<AgentJobView, 'all'> } | { readonly status: string }): boolean {
    const state = this.get(id)
    if (!state) return false
    if ('view' in applies) return state.view === applies.view
    const current = state.columnFilters.find(filter => filter.column === 'status')
    return current?.values?.length === 1 && current.values[0] === applies.status && !current.exclude
  }
  clearFilters(id: string): void {
    this.setView(id, 'all')
    this.setText(id, '')
    if (this.get(id)?.columnFilters.length) this.setState(id, { columnFilters: [] })
  }
  /** The chevron: show (or, for the job shown, hide) a job's last run below the grid. */
  toggleExpanded(id: string, job: { readonly id: string; readonly name: string } | undefined): void {
    const state = this.get(id)
    if (!state) return
    const same = !!job && state.expanded?.id.toLowerCase() === job.id.toLowerCase()
    this.setState(id, { expanded: !job || same ? undefined : { id: job.id.toLowerCase(), name: job.name } })
  }

  private setState(id: string, patch: Pick<Partial<JobActivityState>, 'expanded' | 'columnFilters'>): void {
    const before = this.get(id)
    if (!before) return
    const next = { ...before, ...patch }
    const changed = before.expanded?.id !== next.expanded?.id
    this.patch(id, { ...'expanded' in patch && !patch.expanded ? { ...patch, expanded: undefined } : patch, ...changed ? { lastRunPending: !!next.expanded } : {} })
    if (JSON.stringify(jobActivityArgs(next)) === JSON.stringify(jobActivityArgs(before))) return
    const handle = this.handles.get(id)
    if (!handle) return
    // Set while disconnected too: the subscription after a reconnect takes the args set meanwhile.
    handle.setArgs(jobActivityArgs(next))
    if (!this.live(id)) return
    // The backend applies new args at the next sample: read now so the last run shown is the job just picked, and a view that
    // failed subscribes again with them.
    if (changed || handle.getSnapshot().status === 'ended') handle.refresh()
  }

  // --- The grid and its selection ----------------------------------------------------------------------------------------

  attachGrid(id: string, grid: LiveGrid | undefined): void {
    this.grids.get(id)?.stop()
    this.grids.delete(id)
    if (!grid) return
    const entry = { grid, stop: grid.subscribe(() => this.selectionChanged(id)), read: 0 }
    this.grids.set(id, entry)
    this.selectionChanged(id)
  }
  grid(id: string): LiveGrid | undefined { return this.grids.get(id)?.grid }
  /** The selected jobs once the grid's selection has been read: a click just before (Enter, a double-click) is read first. */
  async settledSelection(id: string): Promise<readonly SelectedJob[]> {
    const entry = this.grids.get(id)
    for (let reading = entry?.reading; entry && reading; reading = entry.reading === reading ? undefined : entry.reading) await reading.catch(() => {})
    return this.get(id)?.selected ?? []
  }

  /**
   * How many jobs are selected now, as the grid knows at once (capped at one over the bulk cap). A menu or a button decides
   * from this, since the selected jobs themselves are read from the rows after a click (a right-click selects its row just
   * before its menu opens); a verb's run waits for them (`settledSelection`).
   */
  selectedCount(id: string): number {
    const entry = this.grids.get(id)
    if (!entry) return this.get(id)?.selected.length ?? 0
    const { table, selection, activeKey } = entry.grid.getSnapshot()
    if (!table || !selection || activeKey === undefined) return 0
    return selectionRows(selection, table.descriptor.rowsAvailable, table.descriptor.columns.length, agentLimits.startJobs + 1).length
  }

  private selectionChanged(id: string): void {
    const entry = this.grids.get(id)
    if (!entry) return
    const snapshot = entry.grid.getSnapshot()
    const table = snapshot.table, selection = snapshot.selection
    if (!table || !selection || snapshot.activeKey === undefined) {
      // A read still in flight is for a selection that is gone: it must not bring it back.
      entry.read++
      if (this.get(id)?.selected.length) this.patch(id, { selected: [], overCap: false })
      return
    }
    const rows = selectionRows(selection, table.descriptor.rowsAvailable, table.descriptor.columns.length, agentLimits.startJobs + 1)
    const read = ++entry.read
    entry.reading = (async () => {
      const selected: SelectedJob[] = []
      // Contiguous runs of rows, each one window.
      for (let at = 0; at < rows.length;) {
        let end = at
        while (end + 1 < rows.length && rows[end + 1] === rows[end] + 1) end++
        const window = await table.handle.getWindow(rows[at], end - at + 1, { colStart: 0, colEnd: readColumns, display: false })
        for (let row = 0; row < window.count; row++) {
          const cell = (column: string) => window.text[row * readColumns + columnIndex[column]] ?? ''
          if (cell('jobId')) selected.push({ id: cell('jobId').toLowerCase(), name: cell('name'), status: cell('status'), lastRun: cell('lastRun'), owner: cell('owner') })
        }
        at = end + 1
      }
      if (this.grids.get(id) !== entry || entry.read !== read) return
      const overCap = selected.length > agentLimits.startJobs
      const kept = selected.slice(0, agentLimits.startJobs)
      const before = this.get(id)
      if (!before || (before.overCap === overCap && JSON.stringify(before.selected) === JSON.stringify(kept))) return
      this.patch(id, { selected: kept, overCap })
    })().catch(onUnexpectedError)
  }

  // --- Bulk verbs ----------------------------------------------------------------------------------------------------------

  /** Why a bulk verb is not offered now, or undefined when it is. */
  bulkUnavailable(id: string): string | undefined {
    const state = this.get(id)
    if (!state || !this.live(id)) return 'Connect to the server first.'
    if (state.bulk?.running) return 'A bulk action is running in this monitor.'
    return bulkUnavailable(this.selectedCount(id))
  }
  canBulk(id: string): boolean { return this.bulkUnavailable(id) === undefined }

  /** One AG-2 verb per selected job, one after another; each job's result is its own line. */
  async runBulk(id: string, verb: AgentBulkVerb): Promise<void> {
    await this.grids.get(id)?.reading
    const state = this.get(id)
    if (!state?.connectionId || !this.canBulk(id)) return
    const connectionId = state.connectionId
    await this.runLines(id, verb, connectionId, [...state.selected], async job => {
      const requestId = this.newId()
      const target = { kind: 'agentJob' as const, name: job.name }
      const agentIdentity = { jobId: job.id }
      // When the request left (monotonic): the status bar dates the Start in server time from it.
      const sentAt = performance.now()
      const result = await this.options.api.executeObjectAction(verb === 'startJob' ? { action: 'startJob', connectionId, requestId, target, agentIdentity }
        : verb === 'stopJob' ? { action: 'stopJob', connectionId, requestId, target, agentIdentity }
        : { action: verb, connectionId, requestId, target, agentIdentity })
      const outcome = bulkLine(verb, result)
      if (verb === 'startJob' && outcome.state === 'done') this.options.started?.(connectionId, job, sentAt)
      return outcome
    })
  }

  /** The jobs one after another, each sent by `send` (or decided by it without a request) as its own result line; Stop, closing the
   *  document or losing the connection sends no more. */
  private async runLines(id: string, verb: BulkRunVerb, connectionId: string, jobs: readonly SelectedJob[], send: (job: SelectedJob) => Promise<Pick<BulkLine, 'state' | 'message'>>): Promise<void> {
    let lines: BulkLine[] = jobs.map(job => ({ id: job.id, name: job.name, state: 'waiting' }))
    const publish = (running: boolean) => this.patch(id, { bulk: { verb, lines, running, stopping: running && !!this.get(id)?.bulk?.stopping } })
    publish(true)
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index]
      if (this.disposed || !this.get(id)) return
      if (this.get(id)?.bulk?.stopping || !this.live(id) || this.get(id)?.connectionId !== connectionId) {
        lines = lines.map(line => line.state === 'waiting' ? { ...line, state: 'skipped', message: this.live(id) ? jobActivityText.skipped : jobActivityText.lost } : line)
        break
      }
      lines = lines.map((line, at) => at === index ? { ...line, state: 'running' } : line)
      publish(true)
      let outcome: Pick<BulkLine, 'state' | 'message'>
      try { outcome = await send(job) } catch (failure) { outcome = bulkLine(verb, undefined, failure) }
      lines = lines.map((line, at) => at === index ? { ...line, ...outcome } : line)
    }
    if (!this.get(id)) return
    publish(false)
    // The rows change on their own from the live view; reading now shows the verbs' effect at once.
    this.handles.get(id)?.refresh()
  }

  // --- Change owner and Attach schedule (AG-3b) ------------------------------------------------------------------------------

  /** Reads a failed form again for the jobs it names, which may not be the selection now (the Agent overview's form never was). */
  async retryForm(id: string): Promise<void> {
    const form = this.get(id)?.form
    if (!form) return
    const refused = await this.openForm(id, form.verb, form.jobs)
    const now = this.get(id)?.form
    if (refused && now?.key === form.key) this.patch(id, { form: { ...now, state: 'failed', error: refused } })
  }

  /** Opens Change owner's or Attach schedule's form for the jobs selected now, and reads what it offers: New Job's describe (whether the login
   *  is sysadmin, and the logins) or the Schedules describe (the shared schedules with their guards, the jobs' versions and, for sysadmin,
   *  which job uses which). A form opened again replaces the last; a read for one replaced or closed is dropped. With `given` it opens for
   *  those jobs instead of the selection (the Agent overview's Change owner… names the jobs its check found, AG-15). */
  async openForm(id: string, verb: AgentBulkFormVerb, given?: readonly SelectedJob[]): Promise<string | undefined> {
    if (!given) await this.settledSelection(id)
    const state = this.get(id)
    if (!state?.connectionId) return agentBulkText.formUnavailable
    // With `given` the caller is another document, which shows why no form opened (the monitor's own bar greys its buttons instead).
    if (given) {
      const refused = !this.live(id) ? agentBulkText.formUnavailable : state.bulk?.running ? agentBulkText.formBusy : bulkUnavailable(given.length)
      if (refused) return refused
    } else if (!this.canBulk(id)) return undefined
    const connectionId = state.connectionId
    const key = this.newId(), jobs = [...given ?? state.selected]
    this.patch(id, { form: verb === 'changeOwner' ? { verb, key, jobs, state: 'loading', owner: '' } : { verb, key, jobs, state: 'loading', search: '' } })
    const requestId = this.newId()
    let failure: string | undefined, value: Awaited<ReturnType<VariaApi['describeObject']>> | undefined
    try {
      value = await this.options.api.describeObject({ connectionId, requestId, dialog: verb === 'changeOwner' ? 'agentJob' : 'agentSchedules', target: { kind: 'agent' } })
    } catch (thrown) { failure = thrown instanceof Error ? thrown.message : String(thrown) }
    const form = this.get(id)?.form
    if (form?.key !== key) return
    if (value && !value.ok) failure = value.error
    else if (value?.value.error) failure = value.value.error.message
    const read = value?.ok ? value.value : undefined
    if (failure !== undefined || !read) { this.patch(id, { form: { ...form, state: 'failed', error: failure ?? agentBulkText.readFailed } }); return }
    if (form.verb === 'changeOwner') {
      const model = read.agentJobDocument
      this.patch(id, { form: model ? { ...form, state: 'ready', sysadmin: model.sysadmin, ...model.owners ? { owners: model.owners } : {} } : { ...form, state: 'failed', error: agentBulkText.readFailed } })
    } else {
      const model = read.agentSchedules
      this.patch(id, { form: model ? { ...form, state: 'ready', model } : { ...form, state: 'failed', error: agentBulkText.readFailed } })
    }
  }
  setFormOwner(id: string, owner: string): void {
    const form = this.get(id)?.form
    if (form?.verb === 'changeOwner' && form.owner !== owner) this.patch(id, { form: { ...form, owner } })
  }
  setFormSearch(id: string, search: string): void {
    const form = this.get(id)?.form
    if (form?.verb === 'attachSchedule' && form.search !== search) this.patch(id, { form: { ...form, search } })
  }
  pickFormSchedule(id: string, schedule: number | undefined): void {
    const form = this.get(id)?.form
    if (form?.verb !== 'attachSchedule' || form.picked === schedule) return
    const { picked: _picked, ...rest } = form
    this.patch(id, { form: schedule === undefined ? rest : { ...rest, picked: schedule } })
  }
  /** Cancel: the form closes and focus goes back to the grid. */
  closeForm(id: string): void {
    if (!this.get(id)?.form) return
    this.patch(id, { form: undefined })
    this.options.focus?.(id)
  }
  /** Why the form's Change or Attach is not offered now, or undefined when it is. */
  formUnavailable(id: string): string | undefined {
    const state = this.get(id), form = state?.form
    if (!state || !form) return 'Open Change owner or Attach schedule first.'
    if (!this.live(id)) return 'Connect to the server first.'
    if (state.bulk?.running) return 'A bulk action is running in this monitor.'
    if (form.state === 'loading') return 'Reading…'
    if (form.state === 'failed') return form.error ?? agentBulkText.readFailed
    if (form.verb === 'changeOwner') return ownerUnavailable(form)
    const record = form.picked === undefined ? undefined : form.model?.schedules.find(item => item.id === form.picked)
    if (!record) return agentBulkText.scheduleNone
    if (record.version === undefined || !record.modified) return agentBulkText.scheduleUnguarded
    return undefined
  }
  /** Change or Attach: the form closes (focus back to the grid) and its jobs go one request each, every result its own line, as the other bulk verbs. */
  async submitForm(id: string): Promise<void> {
    const state = this.get(id), form = state?.form
    if (!state?.connectionId || !form || this.formUnavailable(id)) return
    const connectionId = state.connectionId
    this.patch(id, { form: undefined })
    // The form held focus; the grid takes it back, as after Cancel.
    this.options.focus?.(id)
    const run = async <T>(plan: BulkJobPlan<T>, sendIt: (value: T) => Promise<ApiResult<ActionExecuteResult>>, done: string): Promise<Pick<BulkLine, 'state' | 'message'>> => {
      if (!('send' in plan)) return plan
      const outcome = bulkLine(form.verb, await sendIt(plan.send))
      return outcome.state === 'done' ? { ...outcome, message: done } : outcome
    }
    if (form.verb === 'changeOwner') {
      const owner = form.owner.trim()
      await this.runLines(id, form.verb, connectionId, form.jobs, job => run(ownerPlan(job, owner), jobOwner => this.options.api.executeObjectAction({
        action: 'changeJobOwner', connectionId, requestId: this.newId(), target: { kind: 'agentJob', name: job.name }, agentIdentity: { jobId: job.id }, jobOwner
      }), agentBulkText.ownerDone(owner)))
      return
    }
    const record = form.model!.schedules.find(item => item.id === form.picked)!
    await this.runLines(id, form.verb, connectionId, form.jobs, job => run(attachPlan(job.id, record, form.model?.jobs, form.model?.links), agentSchedule => this.options.api.executeObjectAction({
      action: 'agentSchedule', connectionId, requestId: this.newId(), target: { kind: 'agent' }, agentSchedule
    }), agentBulkText.scheduleDone(record.name)))
  }

  /** Stop: no job after the one on its way gets its verb. */
  stopBulk(id: string): void {
    const bulk = this.get(id)?.bulk
    if (bulk?.running && !bulk.stopping) this.patch(id, { bulk: { ...bulk, stopping: true } })
  }
  /** Close the result lines (Stop first when they still run). */
  closeBulk(id: string): void {
    const bulk = this.get(id)?.bulk
    if (!bulk) return
    if (bulk.running) { this.stopBulk(id); return }
    this.patch(id, { bulk: undefined })
    this.options.focus?.(id)
  }

  refresh(id: string): void { if (this.live(id)) this.handles.get(id)?.refresh() }

  private live(id: string): boolean {
    const connectionId = this.get(id)?.connectionId
    return this.targetBindings.matchesConnection(id, connectionId) && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected'))
  }
  isLive(id: string): boolean { return this.live(id) }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------

  save(): Promise<boolean> { return Promise.resolve(true) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  /** A bulk run still going stops at the job on its way: closing the document is its Stop. */
  closed(id: string): void {
    this.targetBindings.forget(id)
    this.attachGrid(id, undefined)
    this.watches.get(id)?.()
    this.watches.delete(id)
    this.handles.get(id)?.dispose()
    this.handles.delete(id)
    this.gridStates.delete(id)
    this.publish({ documents: Object.fromEntries(Object.entries(this.getSnapshot().documents).filter(([key]) => key !== id)) })
  }

  dispose(): void {
    if (this.disposed) return
    for (const id of Object.keys(this.getSnapshot().documents)) this.closed(id)
    this.disposed = true
    this.targetBindings.clear()
    this.registration.dispose()
    this.stopFollowing()
    this.clearListeners()
  }

  private patch(id: string, patch: Partial<JobActivityState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as JobActivityState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: JobActivityState): void { this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } }) }
}
