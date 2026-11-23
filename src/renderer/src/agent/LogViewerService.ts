// SQL Server Agent's Log File Viewer for job history (AG-5a, docs/sql-server-agent.md): one document per connection showing the
// checked jobs' runs, live. The backend reads and groups the history (the agent.history source); this service owns each document's
// sources (the checked jobs), filters, the selected run and step, the details pane's whole message (agent.historyMessage), this
// login's Agent role (agent.profile, for Delete History), Agent's state from agent.jobs' service probe, and Delete History, which
// runs actions.execute's deleteJobHistory behind a confirmation. AG-5b adds the Agent error logs as more sources of the same viewer:
// their list (agent.errorLogs, sysadmin), the checked logs' rows (the agent.errorLog source, opened while a log is checked, sharing the
// window and text filters), the selected row's message, and Recycle (actions.execute's recycleAgentErrorLog) behind its confirmation.
// Failures are values in the snapshot; nothing throws into React.
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ActionExecuteResult } from '../../../shared/actions/schema'
import { agentLimits } from '../../../shared/agent/catalog'
import {
  agentHistoryProbe, agentHistorySource, deleteHistoryUnavailable, historyActiveFilters, historyArgs, historyDefaultDays, historyUnitLabels, logViewerTabName, parseHistoryRunKey,
  type AgentHistoryDelete, type AgentPurgeUnit, type HistoryFilters, type HistoryOutcome
} from '../../../shared/agent/history'
import { agentAvailability, agentJobsSource, agentServiceProbe, type AgentAvailability, type AgentServiceSample } from '../../../shared/agent/jobs'
import { agentErrorLogProbe, agentErrorLogSource, errorLogArgs, errorLogsUnavailable, recycleText, recycleUnavailable, type AgentErrorLog } from '../../../shared/agent/error-log'
import { agentRoleOf, type AgentProfileState, type AgentRole } from '../../../shared/agent/profile'
import { liveProbes } from '../../../shared/live/catalog'
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

const historySpec = liveProbes[agentHistoryProbe]
const columnsOf = (table: number) => Object.fromEntries(historySpec.tables![table].columns.map((column, index) => [column.id, index])) as Record<string, number>
const jobColumns = columnsOf(2)
const stepColumns = columnsOf(1)
const errorLogSpec = liveProbes[agentErrorLogProbe]
const entryColumns = Object.fromEntries(errorLogSpec.tables![0].columns.map((column, index) => [column.id, index])) as Record<string, number>

/** A job the login may see, from the source's third table: the viewer's sources. */
export interface HistoryJob { readonly id: string; readonly name: string; readonly owner: string; readonly running: boolean }
/** The selected step row as its cells read, for the details pane's heading. */
export interface HistoryStep { readonly instance: number; readonly stepId: string; readonly name: string; readonly outcome: string; readonly started: string; readonly duration: string; readonly messageId: string; readonly severity: string }
/** The details pane's whole message: the row it is for (`job:instance`), and the message, its read in flight, or why it failed. */
export interface HistoryMessage { readonly key: string; readonly state: 'reading' | 'ready' | 'failed'; readonly text?: string }
/** Delete History's confirmation: its scope, and the request on its way or how it ended. */
export interface DeleteConfirm {
  readonly scope: 'all' | 'older'
  readonly count: number
  readonly unit: AgentPurgeUnit
  readonly running: boolean
  readonly error?: { readonly code?: string; readonly message: string }
}

export interface LogViewerState extends HistoryFilters {
  readonly id: string
  readonly connectionId?: string
  readonly server: string
  readonly label: string
  /** A job named by its menu (a job node's View History), checked once the jobs list names its id. */
  readonly pendingJob?: string
  readonly jobs: readonly HistoryJob[]
  /** Why the last change to the checked jobs was refused (more than historyJobs). */
  readonly note?: string
  readonly selectedStep?: HistoryStep
  readonly message?: HistoryMessage
  readonly profile: AgentProfileState
  readonly service?: AgentServiceSample
  /** SQL Server Agent's history caps, where the login may read them (the probe's status). */
  readonly caps?: { readonly maxRows?: number; readonly perJob?: number }
  /** Checked jobs the history cap left unread in the last sample (the probe's historySkippedJobs). */
  readonly skipped?: number
  /** The selected run's first row (its job outcome row, or its first step of a run with none): the details pane's heading with no step selected. */
  readonly headStep?: HistoryStep
  readonly confirm?: DeleteConfirm
  /** The last Delete History's outcome line (msdb's messages), until the next one or Close. */
  readonly deleted?: string
  /** The checked SQL Server Agent error logs by archive number (0 is Current), in the order they were checked (AG-5b). */
  readonly logs: readonly number[]
  /** The error logs Select logs lists (agent.errorLogs, sysadmin): reading, listed (`archives` false where the server lists none), or why not. */
  readonly errorLogs?: ErrorLogList
  /** The selected error log row, for the details pane. */
  readonly entry?: ErrorLogEntry
  /** Recycle's confirmation: its request on its way, or how it failed. */
  readonly recycle?: { readonly running: boolean; readonly error?: { readonly code?: string; readonly message: string } }
  /** The last Recycle's outcome line, until the next one or Close. */
  readonly recycled?: string
}
/** The error logs Select logs lists. */
export interface ErrorLogList { readonly state: 'reading' | 'ready' | 'failed'; readonly logs: readonly AgentErrorLog[]; readonly archives?: boolean; readonly error?: string }
/** An error log row as its cells read. */
export interface ErrorLogEntry { readonly key: string; readonly date: string; readonly source: string; readonly type: string; readonly message: string }
export interface LogViewerSnapshot { readonly documents: Readonly<Record<string, LogViewerState>> }

export interface LogViewerServiceOptions extends CustomDocumentTargetOptions {
  readonly api: Pick<VariaApi, 'executeObjectAction' | 'agentProfile' | 'agentHistoryMessage' | 'agentErrorLogs'>
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot' | 'subscribe'>
  readonly panes: Pick<PaneService, 'getSnapshot' | 'subscribe'>
  readonly groups?: Pick<EditorGroupService, 'getSnapshot' | 'subscribe'>
  readonly live: Pick<LiveService, 'open'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly focus?: (id: string) => void
  readonly newId?: () => string
  /** After a Recycle: Object Explorer reloads the server's Error Logs folder, whose labels changed. */
  readonly recycled?: (connectionId: string) => void
}

export const logViewerText = {
  denied: "This login cannot read SQL Server Agent's job history: msdb grants it to sysadmin and to members of SQLAgentUserRole, SQLAgentReaderRole and SQLAgentOperatorRole.",
  failed: 'The Log File Viewer stopped reading the history.',
  tooMany: `Check at most ${agentLimits.historyJobs} jobs, or check All jobs.`,
  lost: 'The connection closed; whether the history was deleted is unknown. Refresh to check.',
  deleted: (jobs: number) => `Deleted the history of ${jobs} ${jobs === 1 ? 'job' : 'jobs'}.`,
  deletedOlder: (jobs: number, count: number, unit: AgentPurgeUnit) => `Deleted the history older than ${count} ${count === 1 ? historyUnitLabels[unit].slice(0, -1) : historyUnitLabels[unit]} of ${jobs} ${jobs === 1 ? 'job' : 'jobs'}.`,
  ambiguous: (name: string) => `Several jobs are named ${name}: check the one you want in Select logs.`,
  recycleLost: 'The connection closed; whether the error log was recycled is unknown. Refresh to check.'
} as const

/** Where a viewer opens: every job, the jobs given by id (Job Activity Monitor's selection), or one job by name (its node's menu); or (AG-5b)
 *  one Agent error log with no job checked (View Agent Log), with Recycle's confirmation open (`recycle`). */
export type LogViewerOpen = { readonly jobs?: readonly string[]; readonly jobName?: string; readonly errorLog?: number; readonly recycle?: true }

/** A Delete History request's outcome line, or its failure. */
export function deleteOutcome(result: ApiResult<ActionExecuteResult> | undefined, jobs: number, thrown?: unknown, olderThan?: { readonly count: number; readonly unit: AgentPurgeUnit }): { readonly ok: true; readonly line: string } | { readonly ok: false; readonly code?: string; readonly message: string } {
  if (thrown !== undefined) return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) }
  if (!result) return { ok: false, message: logViewerText.lost }
  if (!result.ok) return { ok: false, code: result.code, message: result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? logViewerText.lost : result.error }
  if (result.value.error) return { ok: false, code: result.value.error.code, message: result.value.error.message }
  const messages = result.value.messages.filter(Boolean)
  return { ok: true, line: [olderThan ? logViewerText.deletedOlder(jobs, olderThan.count, olderThan.unit) : logViewerText.deleted(jobs), ...messages].join(' ') }
}

/**
 * The Log File Viewer documents (custom document kind 'agentLogViewer'), one per connection: View History on the Agent node, the
 * Jobs folder, a job and Job Activity Monitor's selection opens it, or shows the open one with those jobs checked.
 */
export class LogViewerService extends SnapshotStore<LogViewerSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'agentLogViewer' as const
  readonly saves = false
  readonly inSaveAll = false
  private readonly newId: () => string
  private readonly registration: Disposable
  private readonly stopFollowing: () => void
  private readonly handles = new Map<string, LiveHandle>()
  private readonly services = new Map<string, LiveHandle>()
  private readonly gridStates = new Map<string, LiveGridState>()
  private readonly grids = new Map<string, { readonly grid: LiveGrid; readonly stop: () => void }>()
  private readonly stepGrids = new Map<string, { readonly grid: LiveGrid; readonly stop: () => void; read: number }>()
  private readonly watches = new Map<string, () => void>()
  private readonly reads = new Map<string, number>()
  private readonly errorHandles = new Map<string, { readonly handle: LiveHandle; args: string }>()
  private readonly entryGrids = new Map<string, { readonly grid: LiveGrid; readonly stop: () => void; read: number }>()
  private readonly logReads = new Map<string, number>()
  private readonly targetBindings: CustomDocumentTargets
  private disposed = false

  constructor(private readonly options: LogViewerServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.registration = options.documents.registerProvider(this)
    const follow = () => { try { this.following() } catch (failure) { onUnexpectedError(failure) } }
    const stopDocuments = options.documents.subscribe(follow), stopConnections = options.connections.subscribe(follow)
    this.stopFollowing = () => { stopDocuments(); stopConnections() }
  }

  get(id: string | undefined): LogViewerState | undefined { return id === undefined ? undefined : this.getSnapshot().documents[id] }
  handle(id: string): LiveHandle | undefined { return this.handles.get(id) }
  gridState(id: string, table: number | 'log'): LiveGridState {
    const key = `${id}:${table}`
    let state = this.gridStates.get(key)
    if (!state) this.gridStates.set(key, state = { topRow: 0, virtualTop: 0, scrollLeft: 0, sized: false })
    return state
  }
  availability(id: string): AgentAvailability { return this.live(id) ? agentAvailability(this.get(id)?.service) : 'pending' }
  role(id: string): AgentRole { return agentRoleOf(this.get(id)?.profile) }
  activeFilters(id: string): number { const state = this.get(id); return state ? historyActiveFilters(state) : 0 }

  // --- Opening ---------------------------------------------------------------------------------------------------------

  open(connectionId: string, where: LogViewerOpen = {}): string {
    if (this.disposed) throw new Error('The Log File Viewer is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!connection) throw new Error('Connect to the server first.')
    if (where.jobs && where.jobs.length > agentLimits.historyJobs) throw new Error(logViewerText.tooMany)
    const checked = where.jobs ? where.jobs.map(id => id.toLowerCase()) : where.jobName !== undefined || where.errorLog !== undefined ? [] : undefined
    const existing = Object.values(this.getSnapshot().documents).find(state => state.connectionId === connectionId)
    if (existing) {
      this.options.documents.activate(existing.id)
      this.setFilters(existing.id, { checked, run: undefined }, { pendingJob: where.jobName, note: undefined, ...where.errorLog !== undefined ? { logs: [where.errorLog], entry: undefined } : {} })
      if (where.recycle) this.askRecycle(existing.id)
      return existing.id
    }
    const label = connection.displayName || connection.server
    const document = this.options.documents.openCustom('agentLogViewer', logViewerTabName(label), connection.id, 'msdb')
    this.targetBindings.bind(document.id, connection.id)
    const state: LogViewerState = {
      id: document.id, connectionId: connection.id, server: connection.server, label, text: '', days: historyDefaultDays, jobs: [], profile: { status: 'unknown' },
      logs: where.errorLog !== undefined ? [where.errorLog] : [],
      ...checked ? { checked } : {}, ...where.jobName !== undefined ? { pendingJob: where.jobName } : {}
    }
    this.put(state)
    this.subscribeLive(state)
    this.syncErrorLog(state.id)
    void this.readProfile(state.id)
    if (where.recycle) this.askRecycle(state.id)
    return document.id
  }

  private subscribeLive(state: LogViewerState): void {
    const owner = documentOwner(state.id, this.options.documents, this.options.panes, this.options.groups)
    const connectionId = () => this.live(state.id) ? this.options.documents.get(state.id)?.connectionId : undefined
    const handle = this.options.live.open({
      connectionId: state.connectionId!, source: agentHistorySource, args: historyArgs(state), probes: [{ probe: agentHistoryProbe, intervalMs: historySpec.intervalMs.default }]
    }, { ...owner, connectionId })
    // Agent's state for the banner, from Job Activity Monitor's service probe: no permission needed, and it says when to read again.
    const service = this.options.live.open({
      connectionId: state.connectionId!, source: agentJobsSource, probes: [{ probe: agentServiceProbe, intervalMs: liveProbes[agentServiceProbe].intervalMs.default }]
    }, { ...owner, connectionId })
    this.handles.set(state.id, handle)
    this.services.set(state.id, service)
    const ticks = handle.onTick(({ tick }) => {
      const sample = tick.samples.find(item => item.probe === agentHistoryProbe)
      if (!sample) return
      const value = (key: string) => { const entry = sample.status?.find(item => item.id === key); return typeof entry?.value === 'number' ? entry.value : undefined }
      if (sample.status?.length) {
        const caps = { maxRows: value('historyMaxRows'), perJob: value('historyMaxRowsPerJob') }
        const before = this.get(state.id)?.caps
        if (before?.maxRows !== caps.maxRows || before?.perJob !== caps.perJob) this.patch(state.id, { caps })
      }
      // Sent only while the cap left checked jobs unread; a sample without it clears it.
      if (sample.tables?.length || sample.status?.length) {
        const skipped = value('historySkippedJobs')
        if (this.get(state.id)?.skipped !== skipped) this.patch(state.id, { skipped })
      }
      void this.readJobs(state.id)
    })
    const serviceTicks = service.onTick(({ tick }) => {
      for (const sample of tick.samples) {
        if (sample.probe !== agentServiceProbe || !sample.status) continue
        const value = (key: string) => { const entry = sample.status!.find(item => item.id === key); return typeof entry?.value === 'number' ? entry.value : undefined }
        const next: AgentServiceSample = { agentXps: value('agentXps'), serviceState: value('serviceState'), startupType: value('startupType') }
        const before = this.get(state.id)?.service
        if (before?.agentXps !== next.agentXps || before?.serviceState !== next.serviceState || before?.startupType !== next.startupType) this.patch(state.id, { service: next })
        // Agent usable again while the history stopped on AGENT_DISABLED: read again so the viewer resumes by itself.
        if (agentAvailability(next) === 'running' && handle.getSnapshot().probes[agentHistoryProbe]?.error?.code === 'AGENT_DISABLED') handle.refresh()
      }
    })
    this.watches.set(state.id, () => { ticks.dispose(); serviceTicks.dispose() })
  }

  private async readProfile(id: string): Promise<void> {
    const connectionId = this.get(id)?.connectionId
    if (!connectionId) return
    let profile: AgentProfileState
    try {
      const result = await this.options.api.agentProfile({ connectionId, requestId: this.newId() })
      profile = !result.ok ? { status: 'failed', error: { code: 'SQL_ERROR', message: result.error, retryable: true } }
        : result.value.profile ? { status: 'ready', profile: result.value.profile }
        : { status: 'failed', error: result.value.error ?? { code: 'SQL_ERROR', message: 'The Agent role could not be read.', retryable: true } }
    } catch (failure) {
      profile = { status: 'failed', error: { code: 'SQL_ERROR', message: failure instanceof Error ? failure.message : String(failure), retryable: true } }
    }
    if (this.get(id)?.connectionId !== connectionId) return
    this.patch(id, { profile })
    const role = agentRoleOf(profile)
    if (role === 'sysadmin') { void this.readErrorLogs(id); return }
    // A login below sysadmin cannot read the error logs and Select logs lists none for it to uncheck: a log checked by View Agent Log
    // (from the palette) is unchecked, and the note says why.
    const why = errorLogsUnavailable(role)
    if (role !== 'unknown' && role !== 'profileFailed' && why && this.get(id)?.logs.length) {
      this.patch(id, { logs: [], entry: undefined, note: why })
      this.syncErrorLog(id)
    }
  }

  /** The jobs list (table 2), after each sample: the sources, and a job named by its menu checked by its id. */
  private async readJobs(id: string): Promise<void> {
    const table = this.handles.get(id)?.table(agentHistoryProbe, 2)
    if (!table) return
    const read = (this.reads.get(id) ?? 0) + 1
    this.reads.set(id, read)
    const count = Math.min(table.descriptor.rowsAvailable, agentLimits.listRows)
    const columns = historySpec.tables![2].columns.length
    const window = count ? await table.handle.getWindow(0, count, { colStart: 0, colEnd: columns, display: false }) : { count: 0, text: [] as string[] }
    if (this.reads.get(id) !== read) return
    const jobs: HistoryJob[] = []
    for (let row = 0; row < window.count; row++) {
      const cell = (column: string) => window.text[row * columns + jobColumns[column]] ?? ''
      if (cell('jobId')) jobs.push({ id: cell('jobId').toLowerCase(), name: cell('jobName'), owner: cell('jobOwner'), running: cell('jobRunning') === 'Yes' })
    }
    const state = this.get(id)
    if (!state) return
    if (JSON.stringify(state.jobs) !== JSON.stringify(jobs)) this.patch(id, { jobs })
    if (state.pendingJob !== undefined) {
      const named = jobs.filter(item => item.name === state.pendingJob)
      // Two jobs may share a name (a multi-server job and a local one): check neither and say so, rather than guess.
      if (named.length > 1) this.patch(id, { pendingJob: undefined, note: logViewerText.ambiguous(state.pendingJob) })
      else if (named.length === 1) this.setFilters(id, { checked: [named[0].id] }, { pendingJob: undefined })
      else if (window.count || table.descriptor.rowsAvailable === 0) this.patch(id, { pendingJob: undefined, note: `The job ${state.pendingJob} is not in the jobs this login sees.` })
    }
  }

  private following(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      const connectionId = this.options.documents.get(state.id)?.connectionId
      if (connectionId === state.connectionId) continue
      // A new connection (a reconnect, or another server): its jobs, caps and the login's role are read again, so the old connection's checked
      // jobs and run go (not when the document only lost its connection). An open Delete History confirmation closes: its jobs were the old
      // connection's, and All jobs would otherwise widen it to every job listed next.
      const moved = connectionId !== undefined && state.connectionId !== undefined
      const confirm = state.confirm?.running ? state.confirm : undefined
      const recycle = state.recycle?.running ? state.recycle : undefined
      this.patch(state.id, {
        connectionId, confirm, recycle, selectedStep: undefined, message: undefined, profile: { status: 'unknown' },
        ...moved ? { jobs: [], caps: undefined, note: undefined, pendingJob: undefined, logs: [], errorLogs: undefined, entry: undefined } : {}
      })
      if (moved) this.setFilters(state.id, { checked: undefined, run: undefined })
      if (connectionId) void this.readProfile(state.id)
      // A run kept through a lost connection reads its message again on the new one (nothing else would, as the run did not change).
      void this.readMessage(state.id)
    }
  }

  /** How the view ended, when it failed: the document then says why in place of its rows. */
  ended(id: string): { readonly code?: string; readonly message: string; readonly denied: boolean } | undefined {
    const snapshot = this.handles.get(id)?.getSnapshot()
    const probe = snapshot?.probes[agentHistoryProbe]?.error
    if (snapshot?.status !== 'ended' && probe?.code === 'PERMISSION_DENIED' && !probe.tables) return { code: probe.code, message: logViewerText.denied, denied: true }
    if (snapshot?.status !== 'ended' || (snapshot.ended ? snapshot.ended.ended !== 'failed' : !snapshot.error)) return undefined
    const code = snapshot.ended?.code ?? snapshot.error?.code
    const denied = code === 'PERMISSION_DENIED'
    return { ...code ? { code } : {}, message: denied ? logViewerText.denied : snapshot.ended?.message ?? snapshot.error?.message ?? logViewerText.failed, denied }
  }

  // --- Sources and filters -------------------------------------------------------------------------------------------------

  /** A job's checkbox; `undefined` the All jobs box. */
  toggleJob(id: string, job: string | undefined): void {
    const state = this.get(id)
    if (!state) return
    if (job === undefined) { this.setFilters(id, { checked: state.checked === undefined ? [] : undefined, run: undefined }, { note: undefined }); return }
    const key = job.toLowerCase()
    const all = state.jobs.map(item => item.id)
    const current = state.checked ?? all
    const next = current.includes(key) ? current.filter(item => item !== key) : [...current, key]
    // Every job checked again reads as All jobs, which has no cap.
    if (next.length === all.length && all.every(item => next.includes(item))) { this.setFilters(id, { checked: undefined, run: undefined }, { note: undefined }); return }
    if (next.length > agentLimits.historyJobs) { this.patch(id, { note: logViewerText.tooMany }); return }
    this.setFilters(id, { checked: next, run: undefined }, { note: undefined })
  }
  /** Whether a job's box is checked, and the All jobs box's tristate. */
  isChecked(id: string, job: string): boolean { const state = this.get(id); return !!state && (state.checked === undefined || state.checked.includes(job.toLowerCase())) }
  allChecked(id: string): boolean | 'mixed' {
    const state = this.get(id)
    if (!state || state.checked === undefined) return true
    return state.checked.length === 0 ? false : 'mixed'
  }
  /** The jobs Delete History would act on: the checked ones (every listed job with All jobs checked). */
  checkedJobs(id: string): readonly HistoryJob[] {
    const state = this.get(id)
    if (!state) return []
    return state.checked === undefined ? state.jobs : state.jobs.filter(job => state.checked!.includes(job.id))
  }

  setDays(id: string, days: number | undefined): void { this.setFilters(id, { days, run: undefined }) }
  setOutcome(id: string, outcome: HistoryOutcome | undefined): void { this.setFilters(id, { outcome, run: undefined }) }
  setText(id: string, text: string): void { if (this.get(id)?.text !== text) this.setFilters(id, { text, run: undefined }) }
  setStep(id: string, step: number | undefined): void { this.setFilters(id, { step, run: undefined }) }
  clearFilters(id: string): void { this.setFilters(id, { days: historyDefaultDays, outcome: undefined, text: '', step: undefined, run: undefined }) }

  private setFilters(id: string, patch: Partial<HistoryFilters>, extra: Partial<LogViewerState> = {}): void {
    const before = this.get(id)
    if (!before) return
    const runChanged = 'run' in patch && (patch.run?.job !== before.run?.job || patch.run?.instance !== before.run?.instance)
    const next = { ...before, ...patch, ...extra }
    this.patch(id, { ...patch, ...extra, ...runChanged ? { selectedStep: undefined, headStep: undefined, message: undefined } : {} })
    this.syncErrorLog(id)
    if (runChanged) void this.readMessage(id)
    if (JSON.stringify(historyArgs(next)) === JSON.stringify(historyArgs(before))) return
    const handle = this.handles.get(id)
    if (!handle) return
    // Set while disconnected too: the subscription after a reconnect takes the args set meanwhile.
    handle.setArgs(historyArgs(next))
    if (this.live(id)) handle.refresh()
  }

  // --- Grids, the selected run and step, and the details pane ----------------------------------------------------------------

  attachRuns(id: string, grid: LiveGrid | undefined): void {
    this.grids.get(id)?.stop()
    this.grids.delete(id)
    if (!grid) return
    const follow = () => {
      const key = grid.getSnapshot().activeKey
      const run = key === undefined ? undefined : parseHistoryRunKey(key)
      const state = this.get(id)
      if (!state || (run?.job === state.run?.job && run?.instance === state.run?.instance)) return
      this.setFilters(id, { run })
    }
    this.grids.set(id, { grid, stop: grid.subscribe(follow) })
    follow()
  }

  attachSteps(id: string, grid: LiveGrid | undefined): void {
    this.stepGrids.get(id)?.stop()
    this.stepGrids.delete(id)
    if (!grid) return
    const entry = { grid, stop: grid.subscribe(() => this.stepChanged(id)), read: 0 }
    this.stepGrids.set(id, entry)
    this.stepChanged(id)
  }

  private stepChanged(id: string): void {
    const entry = this.stepGrids.get(id)
    if (!entry) return
    const snapshot = entry.grid.getSnapshot()
    const read = ++entry.read
    const table = snapshot.table, row = snapshot.selection?.active.row
    const columns = historySpec.tables![1].columns.length
    if (!table || row === undefined || row < 0 || row >= table.descriptor.rowsAvailable || snapshot.activeKey === undefined) {
      if (this.get(id)?.selectedStep) { this.patch(id, { selectedStep: undefined }); void this.readMessage(id) }
      // With no step selected the details pane shows the run's key row (its job outcome row, or its first step): find that row, wherever
      // the grid's sort put it, to head the pane.
      const instance = this.get(id)?.run?.instance
      if (table && instance !== undefined && table.descriptor.rowsAvailable > 0) void (async () => {
        const count = Math.min(table.descriptor.rowsAvailable, historySpec.tables![1].rowCap ?? table.descriptor.rowsAvailable)
        const window = await table.handle.getWindow(0, count, { colStart: 0, colEnd: columns, display: false })
        if (this.stepGrids.get(id) !== entry || entry.read !== read) return
        for (let at = 0; at < window.count; at++) {
          const head = this.stepOf(window.text.slice(at * columns, (at + 1) * columns))
          if (head?.instance !== instance) continue
          if (JSON.stringify(this.get(id)?.headStep) !== JSON.stringify(head)) this.patch(id, { headStep: head })
          return
        }
      })().catch(onUnexpectedError)
      return
    }
    void (async () => {
      const window = await table.handle.getWindow(row, 1, { colStart: 0, colEnd: columns, display: false })
      if (this.stepGrids.get(id) !== entry || entry.read !== read || !window.count) return
      const step = this.stepOf(window.text)
      if (!step) return
      if (JSON.stringify(this.get(id)?.selectedStep) === JSON.stringify(step)) return
      this.patch(id, { selectedStep: step })
      await this.readMessage(id)
    })().catch(onUnexpectedError)
  }

  /** A steps-table row's cells as a step, or undefined without a valid instance. */
  private stepOf(text: readonly string[]): HistoryStep | undefined {
    const cell = (column: string) => text[stepColumns[column]] ?? ''
    const instance = Number(cell('stepInstance'))
    if (!Number.isInteger(instance) || instance < 1) return undefined
    return {
      instance, stepId: cell('stepId'), name: cell('stepName'), outcome: cell('stepOutcome'), started: cell('stepStarted'), duration: cell('stepDuration'),
      messageId: cell('stepMessageId'), severity: cell('stepSeverity')
    }
  }

  /** The details pane's whole message: the selected step row's, else the selected run's newest row (its job outcome row). */
  private async readMessage(id: string): Promise<void> {
    const state = this.get(id)
    if (!state?.run || !state.connectionId) { if (state?.message) this.patch(id, { message: undefined }); return }
    const instance = state.selectedStep?.instance ?? state.run.instance
    const key = `${state.run.job}:${instance}`
    if (state.message?.key === key && state.message.state !== 'failed') return
    this.patch(id, { message: { key, state: 'reading' } })
    let message: HistoryMessage
    try {
      const result = await this.options.api.agentHistoryMessage({ connectionId: state.connectionId, requestId: this.newId(), jobId: state.run.job, instanceId: instance })
      message = !result.ok ? { key, state: 'failed', text: result.error }
        : result.value.error ? { key, state: 'failed', text: result.value.error.message }
        : { key, state: 'ready', text: result.value.message ?? '' }
    } catch (failure) { message = { key, state: 'failed', text: failure instanceof Error ? failure.message : String(failure) } }
    if (this.get(id)?.message?.key === key) this.patch(id, { message })
  }
  /** Retry the details pane's read. */
  retryMessage(id: string): void { const state = this.get(id); if (state?.message?.state === 'failed') { this.patch(id, { message: undefined }); void this.readMessage(id) } }

  // --- Delete History ----------------------------------------------------------------------------------------------------------

  deleteUnavailable(id: string): string | undefined {
    const state = this.get(id)
    if (!state) return 'Open the Log File Viewer first.'
    if (state.confirm?.running) return 'Delete History is running.'
    const checked = this.checkedJobs(id)
    return deleteHistoryUnavailable({
      role: this.role(id), purge: state.profile.status === 'ready' ? state.profile.profile.purgeHistory : undefined, checked: checked.length, live: this.live(id)
    })
  }
  canDelete(id: string): boolean { return this.deleteUnavailable(id) === undefined }

  /** Opens the confirmation (Cancel is its default). */
  askDelete(id: string): void {
    if (!this.canDelete(id) || this.get(id)?.confirm) return
    this.patch(id, { confirm: { scope: 'older', count: 30, unit: 1, running: false } })
  }
  setConfirm(id: string, patch: Partial<Pick<DeleteConfirm, 'scope' | 'count' | 'unit'>>): void {
    const confirm = this.get(id)?.confirm
    if (confirm && !confirm.running) this.patch(id, { confirm: { ...confirm, ...patch, error: undefined } })
  }
  cancelDelete(id: string): void {
    if (this.get(id)?.confirm && !this.get(id)?.confirm?.running) { this.patch(id, { confirm: undefined }); this.options.focus?.(id) }
  }

  async confirmDelete(id: string): Promise<void> {
    const state = this.get(id)
    const confirm = state?.confirm
    if (!state?.connectionId || !confirm || confirm.running) return
    const jobs = this.checkedJobs(id).map(job => job.id)
    if (!jobs.length || jobs.length > agentLimits.historyJobs) { this.patch(id, { confirm: { ...confirm, error: { message: this.deleteUnavailable(id) ?? logViewerText.tooMany } } }); return }
    const count = Math.trunc(confirm.count)
    if (confirm.scope === 'older' && !(count >= 1 && count <= agentLimits.purgeCount)) {
      this.patch(id, { confirm: { ...confirm, error: { message: `Enter a number from 1 to ${agentLimits.purgeCount}.` } } })
      return
    }
    const agentHistory: AgentHistoryDelete = confirm.scope === 'all' ? { jobs, all: true } : { jobs, olderThan: { count, unit: confirm.unit } }
    this.patch(id, { confirm: { ...confirm, running: true, error: undefined } })
    let result: ApiResult<ActionExecuteResult> | undefined, thrown: unknown
    try {
      result = await this.options.api.executeObjectAction({ action: 'deleteJobHistory', connectionId: state.connectionId, requestId: this.newId(), target: { kind: 'agent' }, agentHistory })
    } catch (failure) { thrown = failure }
    if (!this.get(id)) return
    const outcome = deleteOutcome(result, jobs.length, thrown, agentHistory.olderThan)
    if (!outcome.ok) { this.patch(id, { confirm: { ...confirm, running: false, error: { ...outcome.code ? { code: outcome.code } : {}, message: outcome.message } } }); return }
    this.patch(id, { confirm: undefined, deleted: outcome.line, message: undefined, selectedStep: undefined })
    // The selected run may outlive an older-than delete: read its message again (gone, if the delete took it).
    void this.readMessage(id)
    this.options.focus?.(id)
    this.refresh(id)
  }
  closeDeleted(id: string): void { if (this.get(id)?.deleted) this.patch(id, { deleted: undefined }) }

  refresh(id: string): void {
    if (!this.live(id)) return
    this.handles.get(id)?.refresh()
    this.errorHandles.get(id)?.handle.refresh()
    if (this.get(id)?.profile.status !== 'ready') void this.readProfile(id)
    else if (this.role(id) === 'sysadmin') void this.readErrorLogs(id)
  }

  private live(id: string): boolean {
    const connectionId = this.get(id)?.connectionId
    return this.targetBindings.matchesConnection(id, connectionId) && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected'))
  }
  isLive(id: string): boolean { return this.live(id) }

  // --- SQL Server Agent error logs (AG-5b) ----------------------------------------------------------------------------------

  /** The checked error logs' live view, while one is checked. */
  errorLogHandle(id: string): LiveHandle | undefined { return this.errorHandles.get(id)?.handle }
  /** Why Select logs lists no error logs, or undefined when it does. */
  errorLogsUnavailable(id: string): string | undefined { return errorLogsUnavailable(this.role(id)) }

  /** An error log's checkbox. */
  toggleLog(id: string, archive: number): void {
    const state = this.get(id)
    if (!state) return
    const logs = state.logs.includes(archive) ? state.logs.filter(log => log !== archive) : [...state.logs, archive]
    this.patch(id, { logs, ...logs.length ? {} : { entry: undefined } })
    this.syncErrorLog(id)
  }
  isLogChecked(id: string, archive: number): boolean { return !!this.get(id)?.logs.includes(archive) }

  /** Opens, re-aims or closes the error log view to match the checked logs and the shared window and text filters. */
  private syncErrorLog(id: string): void {
    const state = this.get(id)
    if (!state?.connectionId) return
    const args = errorLogArgs(state.logs, state)
    const entry = this.errorHandles.get(id)
    if (!args) { if (entry) this.closeErrorLog(id); return }
    const text = JSON.stringify(args)
    if (entry) {
      if (entry.args === text) return
      entry.args = text
      // Set while disconnected too: the subscription after a reconnect takes the args set meanwhile.
      entry.handle.setArgs(args)
      if (this.live(id)) entry.handle.refresh()
      return
    }
    const owner = documentOwner(id, this.options.documents, this.options.panes, this.options.groups)
    const connectionId = () => this.live(id) ? this.options.documents.get(id)?.connectionId : undefined
    const handle = this.options.live.open({
      connectionId: state.connectionId, source: agentErrorLogSource, args, probes: [{ probe: agentErrorLogProbe, intervalMs: errorLogSpec.intervalMs.default }]
    }, { ...owner, connectionId })
    this.errorHandles.set(id, { handle, args: text })
  }
  private closeErrorLog(id: string): void {
    this.attachEntries(id, undefined)
    this.errorHandles.get(id)?.handle.dispose()
    this.errorHandles.delete(id)
    this.gridStates.delete(`${id}:log`)
  }

  /** agent.errorLogs: the logs Select logs lists (sysadmin; Current alone where the server lists none). */
  private async readErrorLogs(id: string): Promise<void> {
    const connectionId = this.get(id)?.connectionId
    if (!connectionId) return
    const read = (this.logReads.get(id) ?? 0) + 1
    this.logReads.set(id, read)
    const before = this.get(id)?.errorLogs
    this.patch(id, { errorLogs: { state: 'reading', logs: before?.logs ?? [], ...before?.archives !== undefined ? { archives: before.archives } : {} } })
    let list: ErrorLogList
    try {
      const result = await this.options.api.agentErrorLogs({ connectionId, requestId: this.newId() })
      list = !result.ok ? { state: 'failed', logs: [], error: result.error }
        : result.value.error ? { state: 'failed', logs: [], error: result.value.error.message }
        : { state: 'ready', logs: result.value.logs, archives: result.value.archives }
    } catch (failure) { list = { state: 'failed', logs: [], error: failure instanceof Error ? failure.message : String(failure) } }
    if (this.logReads.get(id) === read && this.get(id)?.connectionId === connectionId) this.patch(id, { errorLogs: list })
  }
  retryErrorLogs(id: string): void { void this.readErrorLogs(id) }

  attachEntries(id: string, grid: LiveGrid | undefined): void {
    this.entryGrids.get(id)?.stop()
    this.entryGrids.delete(id)
    if (!grid) return
    const entry = { grid, stop: grid.subscribe(() => this.entryChanged(id)), read: 0 }
    this.entryGrids.set(id, entry)
    this.entryChanged(id)
  }

  /** The selected error log row's cells, for the details pane. */
  private entryChanged(id: string): void {
    const entry = this.entryGrids.get(id)
    if (!entry) return
    const snapshot = entry.grid.getSnapshot()
    const read = ++entry.read
    const table = snapshot.table, row = snapshot.selection?.active.row
    if (!table || row === undefined || row < 0 || row >= table.descriptor.rowsAvailable || snapshot.activeKey === undefined) {
      if (this.get(id)?.entry) this.patch(id, { entry: undefined })
      return
    }
    const columns = errorLogSpec.tables![0].columns.length
    void (async () => {
      const window = await table.handle.getWindow(row, 1, { colStart: 0, colEnd: columns, display: true })
      if (this.entryGrids.get(id) !== entry || entry.read !== read || !window.count) return
      const cell = (column: string) => window.text[entryColumns[column]] ?? ''
      const next: ErrorLogEntry = { key: cell('logKey'), date: cell('logDate'), source: cell('logSource'), type: cell('logType'), message: cell('logMessage') }
      if (JSON.stringify(this.get(id)?.entry) !== JSON.stringify(next)) this.patch(id, { entry: next })
    })().catch(onUnexpectedError)
  }

  recycleUnavailable(id: string): string | undefined {
    const state = this.get(id)
    if (!state) return 'Open the Log File Viewer first.'
    if (state.recycle?.running) return 'Recycle is running.'
    return recycleUnavailable({ role: this.role(id), live: this.live(id), managedInstance: state.profile.status === 'ready' && state.profile.profile.platform === 'managedInstance' })
  }
  canRecycle(id: string): boolean { return this.recycleUnavailable(id) === undefined }

  /** Opens Recycle's confirmation (Cancel is its default). While the role is still being read it opens, and OK waits for it. */
  askRecycle(id: string): void {
    const state = this.get(id)
    if (!state || state.recycle) return
    const why = this.recycleUnavailable(id)
    if (why && this.role(id) !== 'unknown') { this.patch(id, { note: why }); return }
    this.patch(id, { recycle: { running: false } })
  }
  cancelRecycle(id: string): void {
    if (this.get(id)?.recycle && !this.get(id)?.recycle?.running) { this.patch(id, { recycle: undefined }); this.options.focus?.(id) }
  }

  async confirmRecycle(id: string): Promise<void> {
    const state = this.get(id)
    const recycle = state?.recycle
    if (!state?.connectionId || !recycle || recycle.running) return
    const why = this.recycleUnavailable(id)
    if (why) { this.patch(id, { recycle: { running: false, error: { message: why } } }); return }
    const connectionId = state.connectionId
    this.patch(id, { recycle: { running: true } })
    let result: ApiResult<ActionExecuteResult> | undefined, thrown: unknown
    try {
      result = await this.options.api.executeObjectAction({ action: 'recycleAgentErrorLog', connectionId, requestId: this.newId(), target: { kind: 'agent' } })
    } catch (failure) { thrown = failure }
    if (!this.get(id)) return
    const failed = thrown !== undefined ? { message: thrown instanceof Error ? thrown.message : String(thrown) }
      : !result ? { message: logViewerText.recycleLost }
      : !result.ok ? { code: result.code, message: result.code === 'BACKEND_LOST' || result.code === 'CONNECTION_LOST' ? logViewerText.recycleLost : result.error }
      : result.value.error ? { code: result.value.error.code, message: result.value.error.message } : undefined
    if (failed) { this.patch(id, { recycle: { running: false, error: failed } }); return }
    this.patch(id, { recycle: undefined, recycled: recycleText.done, entry: undefined })
    this.options.focus?.(id)
    this.options.recycled?.(connectionId)
    this.refresh(id)
  }
  closeRecycled(id: string): void { if (this.get(id)?.recycled) this.patch(id, { recycled: undefined }) }

  // --- CustomDocumentProvider ------------------------------------------------------------------------------------------

  save(): Promise<boolean> { return Promise.resolve(true) }
  canClose(): string | undefined { return undefined }
  revision(): number { return 0 }
  focus(id: string): void { this.options.focus?.(id) }
  follows(_id: string, _server: string): boolean { return false }
  canFollowTarget(id: string, targetId: string): boolean { return this.targetBindings.canFollowTarget(id, targetId) }
  coalesceTarget(id: string, fromTargetId: string, toTargetId: string): boolean { return this.targetBindings.coalesceTarget(id, fromTargetId, toTargetId) }
  closed(id: string): void {
    this.targetBindings.forget(id)
    this.attachRuns(id, undefined)
    this.attachSteps(id, undefined)
    this.attachEntries(id, undefined)
    this.closeErrorLog(id)
    this.logReads.delete(id)
    this.watches.get(id)?.()
    this.watches.delete(id)
    this.handles.get(id)?.dispose()
    this.handles.delete(id)
    this.services.get(id)?.dispose()
    this.services.delete(id)
    this.reads.delete(id)
    this.gridStates.delete(`${id}:0`)
    this.gridStates.delete(`${id}:1`)
    this.gridStates.delete(`${id}:log`)
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

  private patch(id: string, patch: Partial<LogViewerState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as LogViewerState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: LogViewerState): void { this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } }) }
}

