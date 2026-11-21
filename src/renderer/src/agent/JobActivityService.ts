// SQL Server Agent's Job Activity Monitor (AG-3, docs/sql-server-agent.md): one document per connection showing every job
// msdb lets the login see, live. The backend reads and filters the jobs (the agent.jobs source); this service owns each
// document's view chip, filter box and column value filters, the expanded job whose last run shows in place, the grid's kept
// state and selection, the tiles' counts, Agent's state from the service probe, and the bulk verbs (Start, Stop, Enable,
// Disable), which send one AG-2 job verb per selected job, one after another, each with its own result line. Failures are
// values in the snapshot; nothing throws into React.
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ActionExecuteResult } from '../../../shared/actions/schema'
import { agentLimits } from '../../../shared/agent/catalog'
import {
  agentAvailability, agentBulkTitles, agentJobFilterLimits, agentJobTextColumns, agentJobsProbe, agentJobsSource, agentServiceProbe, bulkUnavailable, jobActivityTabName,
  type AgentAvailability, type AgentBulkVerb, type AgentJobColumnFilter, type AgentJobsArgs, type AgentJobView, type AgentServiceSample
} from '../../../shared/agent/jobs'
import { liveProbes } from '../../../shared/live/catalog'
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
const readColumns = columnIndex.created + 1

/** A job selected in the grid, as its cells read: what a bulk verb sends (its name and the identity msdb listed) and shows. */
export interface SelectedJob {
  readonly id: string
  readonly name: string
  /** date_created as yyyy-MM-ddTHH:mm:ss: the AG-2 verbs refuse a job replaced since under the same name. */
  readonly created: string
  readonly status: string
  /** Its last run's start as the grid shows it (yyyy-MM-dd HH:mm:ss, server time), or '' when it never ran. */
  readonly lastRun: string
}
export type BulkLineState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'
export interface BulkLine { readonly id: string; readonly name: string; readonly state: BulkLineState; readonly message?: string }
/** A bulk verb's run: one line per job, in the order they go; Stop sends no more after the one on its way. */
export interface BulkRun { readonly verb: AgentBulkVerb; readonly lines: readonly BulkLine[]; readonly running: boolean; readonly stopping: boolean }

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
  /** The tiles' counts from the last list sample, in the probe's series order (null where none yet). */
  readonly counts?: readonly (number | null)[]
  readonly service?: AgentServiceSample
  readonly facets: Readonly<Record<string, LiveFacet>>
}
export interface JobActivitySnapshot { readonly documents: Readonly<Record<string, JobActivityState>> }

/** How the document's view ended by failing (a login msdb refuses, PERMISSION_DENIED; Agent XPs off at open, AGENT_DISABLED). */
export interface JobActivityEnd { readonly code?: string; readonly message: string; readonly denied: boolean }

export interface JobActivityServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'executeObjectAction'>
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
  bulkDone: (verb: AgentBulkVerb, done: number, total: number) => `${agentBulkTitles[verb].line}: ${done} of ${total} ${total === 1 ? 'job' : 'jobs'} done.`,
  lineDone: { startJob: 'Start requested', stopJob: 'Stop requested', enable: 'Enabled', disable: 'Disabled' } satisfies { readonly [V in AgentBulkVerb]: string },
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
export function bulkLine(verb: AgentBulkVerb, result: ApiResult<ActionExecuteResult> | undefined, thrown?: unknown): Pick<BulkLine, 'state' | 'message'> {
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
    this.stopFollowing = () => { stopDocuments(); stopConnections() }
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
          if (this.get(state.id)?.lastRunPending) patch = { ...patch, lastRunPending: false }
          if (sample.metrics) patch = { ...patch, counts: [...sample.metrics] }
          const facets = sample.tables?.find(table => table.table === 0)?.facets
          if (facets?.length) patch = { ...patch, facets: { ...this.get(state.id)?.facets, ...patch.facets, ...Object.fromEntries(facets.map(facet => [facet.column, facet])) } }
        }
        if (sample.probe === agentServiceProbe && sample.status) {
          // Every service sample carries what it read; a value left out is unknown, so the sample replaces the last whole.
          const value = (id: string) => { const entry = sample.status!.find(item => item.id === id); return typeof entry?.value === 'number' ? entry.value : undefined }
          const service: AgentServiceSample = { agentXps: value('agentXps'), serviceState: value('serviceState'), startupType: value('startupType') }
          const before = this.get(state.id)?.service
          if (before?.agentXps !== service.agentXps || before?.serviceState !== service.serviceState || before?.startupType !== service.startupType) patch = { ...patch, service }
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
      if (connectionId !== state.connectionId) this.patch(state.id, { connectionId, selected: [], overCap: false })
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
          if (cell('jobId')) selected.push({ id: cell('jobId').toLowerCase(), name: cell('name'), created: cell('created'), status: cell('status'), lastRun: cell('lastRun') })
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
    if (state.overCap) return bulkUnavailable(agentLimits.startJobs + 1)
    return bulkUnavailable(state.selected.length)
  }
  canBulk(id: string): boolean { return this.bulkUnavailable(id) === undefined }

  /** One AG-2 verb per selected job, one after another; each job's result is its own line. */
  async runBulk(id: string, verb: AgentBulkVerb): Promise<void> {
    await this.grids.get(id)?.reading
    const state = this.get(id)
    if (!state?.connectionId || !this.canBulk(id)) return
    const connectionId = state.connectionId
    const jobs = [...state.selected]
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
      const requestId = this.newId()
      const target = { kind: 'agentJob' as const, name: job.name }
      const agentIdentity = { created: job.created }
      let result: ApiResult<ActionExecuteResult> | undefined, thrown: unknown
      // When the request left (monotonic): the status bar dates the Start in server time from it.
      const sentAt = performance.now()
      try {
        result = await this.options.api.executeObjectAction(verb === 'startJob' ? { action: 'startJob', connectionId, requestId, target, agentIdentity }
          : verb === 'stopJob' ? { action: 'stopJob', connectionId, requestId, target, agentIdentity }
          : { action: verb, connectionId, requestId, target, agentIdentity })
      } catch (failure) { thrown = failure }
      const outcome = bulkLine(verb, result, thrown)
      lines = lines.map((line, at) => at === index ? { ...line, ...outcome } : line)
      if (verb === 'startJob' && outcome.state === 'done') this.options.started?.(connectionId, job, sentAt)
    }
    if (!this.get(id)) return
    publish(false)
    // The rows change on their own from the live view; reading now shows the verbs' effect at once.
    this.handles.get(id)?.refresh()
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
