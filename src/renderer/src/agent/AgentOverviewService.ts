// SQL Server Agent's overview and health checks (AG-15, docs/sql-server-agent.md › Agent overview): one document per connection. The
// backend gathers the facts (the agent.overview source, sampled on the backend's schedule; Check again asks for a sample now); this service
// reads each sample's tables and status back, turns them into checks and tiles through src/shared/agent/overview.ts, and runs a check's fix
// through the surface that owns it (Job Activity Monitor, the job document, Agent Properties, Add recommended alerts, Schedules, Start Agent).
// The overview writes nothing itself. Failures are values in the snapshot; nothing throws into React.
import {
  agentOverviewProbe, agentOverviewSource, agentOverviewTabName, overviewChecks, overviewReads, overviewStatus, overviewTiles,
  type OverviewAlert, type OverviewCheck, type OverviewFacts, type OverviewFix, type OverviewJob, type OverviewObject, type OverviewRead, type OverviewReadState,
  type OverviewSchedule, type OverviewTile
} from '../../../shared/agent/overview'
import type { AgentJobView } from '../../../shared/agent/jobs'
import { liveProbes } from '../../../shared/live/catalog'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import { documentOwner, type LiveHandle, type LiveService, type LiveTable } from '../live/LiveService'
import type { LiveConnection } from '../services/connections'
import { CustomDocumentTargets, type CustomDocumentTargetOptions } from '../services/custom-document-targets'
import type { CustomDocumentProvider, DocumentService } from '../services/documents'
import type { EditorGroupService } from '../services/editor-groups'
import type { PaneService } from '../services/panes'

/** How a check's fix runs: each through the surface that owns it. A failure throws, and the document shows it. */
export interface AgentOverviewFixes {
  readonly failedJobs: (connectionId: string) => void
  readonly jobsView?: (connectionId: string, view: AgentJobView) => void
  readonly alerts?: (connectionId: string) => void
  readonly changeOwner: (connectionId: string, jobs: readonly { readonly id: string; readonly name: string; readonly owner: string }[]) => void | Promise<void>
  readonly openJob: (connectionId: string, name: string, section?: 'notifications') => void
  readonly agentProperties: (connectionId: string, page?: 'history') => void
  readonly recommendedAlerts: (connectionId: string) => void
  readonly schedules: (connectionId: string) => void
  readonly startAgent: (connectionId: string) => void | Promise<void>
}

export interface AgentOverviewState {
  readonly id: string
  /** The document's connection; absent while it has none (closed, or the backend restarted). */
  readonly connectionId?: string
  readonly server: string
  readonly label: string
  /** The last sample's facts, checks and tiles; absent before the first. */
  readonly facts?: OverviewFacts
  readonly checks?: readonly OverviewCheck[]
  readonly tiles?: readonly OverviewTile[]
  /** A fix that could not run, said once below the header until the next one. */
  readonly notice?: string
}
export interface AgentOverviewSnapshot { readonly documents: Readonly<Record<string, AgentOverviewState>> }

export interface AgentOverviewServiceOptions extends CustomDocumentTargetOptions {
  readonly documents: Pick<DocumentService, 'openCustom' | 'registerProvider' | 'get' | 'activate' | 'getSnapshot' | 'subscribe'>
  readonly panes: Pick<PaneService, 'getSnapshot' | 'subscribe'>
  readonly groups?: Pick<EditorGroupService, 'getSnapshot' | 'subscribe'>
  readonly live: Pick<LiveService, 'open'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly fixes: AgentOverviewFixes
  readonly focus?: (id: string) => void
}

export const agentOverviewText = {
  failed: 'The Agent overview stopped reading SQL Server Agent.',
  notConnected: 'Connect to the server again to run this fix.'
} as const

/** Restores focus on an Agent Overview document: actionable check button, then KPI tile, then header tool, then any enabled button. */
export function focusAgentOverview(id: string): void {
  const root = document.querySelector<HTMLElement>(`[data-agent-overview="${CSS.escape(id)}"]`)
  ;(root?.querySelector<HTMLElement>('.ov-check button:not(:disabled)')
    ?? root?.querySelector<HTMLElement>('.agent-overview-tile:not(:disabled)')
    ?? root?.querySelector<HTMLElement>('.document-actions button:not(:disabled)')
    ?? root?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus()
}

const spec = liveProbes[agentOverviewProbe]
const columnsOf = (table: number) => Object.fromEntries(spec.tables![table]!.columns.map((column, index) => [column.id, index])) as Record<string, number>
const tableColumns = [0, 1, 2, 3].map(columnsOf)

/** A table's rows as cell readers (display texts, '' for NULL), at most its cap. */
async function rowsOf(table: LiveTable | undefined, index: number): Promise<((column: string) => string | undefined)[]> {
  if (!table) return []
  const count = Math.min(table.descriptor.rowsAvailable, spec.tables![index]!.rowCap ?? 5000)
  if (!count) return []
  const columns = spec.tables![index]!.columns.length, names = tableColumns[index]!
  const window = await table.handle.getWindow(0, count, { colStart: 0, colEnd: columns, display: false })
  return Array.from({ length: window.count }, (_, row) => (column: string) => {
    const at = row * columns + names[column]!, text = window.text[at]
    return text === undefined || ((window.flags[at] ?? 0) & 1) !== 0 || (text === '' && column !== 'jobOwner') ? undefined : text
  })
}
const num = (text: string | undefined): number | undefined => text === undefined || !/^-?\d+$/.test(text) ? undefined : Number(text)

/** One sample's tables as facts (exported for the checks). */
export function factsOfRows(status: readonly { readonly id: string; readonly value: number | string }[], jobs: readonly ((column: string) => string | undefined)[],
  alerts: readonly ((column: string) => string | undefined)[], schedules: readonly ((column: string) => string | undefined)[], reads: readonly ((column: string) => string | undefined)[]): OverviewFacts {
  const readStates: Partial<Record<OverviewRead, OverviewReadState>> = {}
  for (const cell of reads) {
    const id = cell('readId') as OverviewRead | undefined
    if (!id || !(overviewReads as readonly string[]).includes(id)) continue
    const message = cell('readMessage')
    readStates[id] = { state: cell('readState') ?? 'SQL_ERROR', ...message ? { message } : {}, ...cell('readTruncated') === '1' ? { truncated: true } : {} }
  }
  const job = (cell: (column: string) => string | undefined): OverviewJob | undefined => {
    const id = cell('jobId'), name = cell('jobName')
    if (!id || name === undefined) return undefined
    const optional = <K extends string>(key: K, value: number | string | undefined) => value === undefined ? {} : { [key]: value } as Record<K, number | string>
    return {
      id, name, enabled: num(cell('jobEnabled')) === 1, owner: cell('jobOwner') ?? '', category: cell('jobCategory') ?? '',
      notifyEmail: num(cell('jobNotifyEmail')) ?? 0, notifyPage: num(cell('jobNotifyPage')) ?? 0, notifyNetsend: num(cell('jobNotifyNetsend')) ?? 0, scheduled: num(cell('jobScheduled')) === 1,
      ...optional('outcome', num(cell('jobOutcome'))), ...optional('lastRun', cell('jobLastRun')), ...optional('status', num(cell('jobStatus'))),
      ...optional('ownerState', num(cell('jobOwnerState'))), ...optional('historyRows', num(cell('jobHistoryRows'))), ...optional('historyRuns', num(cell('jobHistoryRuns'))),
      ...optional('historyOldest', cell('jobHistoryOldest')), ...optional('created', cell('jobCreated'))
    } as OverviewJob
  }
  const alert = (cell: (column: string) => string | undefined): OverviewAlert | undefined => {
    const name = cell('alertName')
    if (name === undefined) return undefined
    const last = cell('alertLast')
    return { name, enabled: num(cell('alertEnabled')) === 1, messageId: num(cell('alertMessageId')) ?? 0, severity: num(cell('alertSeverity')) ?? 0, ...last ? { lastOccurred: last } : {}, notifies: (num(cell('alertNotifies')) ?? 0) > 0 }
  }
  const schedule = (cell: (column: string) => string | undefined): OverviewSchedule | undefined => {
    const id = num(cell('scheduleId')), name = cell('scheduleName')
    return id === undefined || name === undefined ? undefined : { id, name, enabled: num(cell('scheduleEnabled')) === 1, jobs: num(cell('scheduleJobs')) ?? 0 }
  }
  return {
    ...overviewStatus(status),
    jobs: jobs.map(job).filter((item): item is OverviewJob => !!item),
    alerts: alerts.map(alert).filter((item): item is OverviewAlert => !!item),
    schedules: schedules.map(schedule).filter((item): item is OverviewSchedule => !!item),
    reads: readStates
  }
}

/** The Agent overview documents (custom document kind 'agentOverview'), one per connection. */
export class AgentOverviewService extends SnapshotStore<AgentOverviewSnapshot> implements Disposable, CustomDocumentProvider {
  readonly kind = 'agentOverview' as const
  readonly saves = false
  readonly inSaveAll = false
  private readonly registration: Disposable
  private readonly stopFollowing: () => void
  private readonly handles = new Map<string, LiveHandle>()
  private readonly watches = new Map<string, () => void>()
  private readonly reads = new Map<string, number>()
  private readonly targetBindings: CustomDocumentTargets
  private disposed = false

  constructor(private readonly options: AgentOverviewServiceOptions) {
    super({ documents: {} })
    this.targetBindings = new CustomDocumentTargets(options)
    this.registration = options.documents.registerProvider(this)
    const follow = () => { try { this.following() } catch (failure) { onUnexpectedError(failure) } }
    const stopDocuments = options.documents.subscribe(follow), stopConnections = options.connections.subscribe(follow)
    this.stopFollowing = () => { stopDocuments(); stopConnections() }
  }

  get(id: string | undefined): AgentOverviewState | undefined { return id === undefined ? undefined : this.getSnapshot().documents[id] }
  handle(id: string): LiveHandle | undefined { return this.handles.get(id) }

  /** Opens the connection's overview, or shows the open one. */
  open(connectionId: string): string {
    if (this.disposed) throw new Error('The Agent overview is not available.')
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId && !item.lost && (!item.lifecycle || item.lifecycle.state === 'connected'))
    if (!connection) throw new Error('Connect to the server first.')
    const existing = Object.values(this.getSnapshot().documents).find(state => state.connectionId === connectionId)
    if (existing) { this.options.documents.activate(existing.id); return existing.id }
    const label = connection.displayName || connection.server
    const document = this.options.documents.openCustom('agentOverview', agentOverviewTabName(label), connection.id, 'msdb')
    this.targetBindings.bind(document.id, connection.id)
    const state: AgentOverviewState = { id: document.id, connectionId: connection.id, server: connection.server, label }
    this.put(state)
    this.subscribeLive(state)
    return document.id
  }

  private subscribeLive(state: AgentOverviewState): void {
    const owner = documentOwner(state.id, this.options.documents, this.options.panes, this.options.groups)
    const handle = this.options.live.open({
      connectionId: state.connectionId!, source: agentOverviewSource, probes: [{ probe: agentOverviewProbe, intervalMs: spec.intervalMs.default }]
    }, { ...owner, connectionId: () => this.live(state.id) ? this.options.documents.get(state.id)?.connectionId : undefined })
    this.handles.set(state.id, handle)
    const ticks = handle.onTick(({ tick }) => {
      const sample = tick.samples.find(item => item.probe === agentOverviewProbe && !item.resorted)
      if (sample) void this.read(state.id, sample.status ?? []).catch(onUnexpectedError)
    })
    this.watches.set(state.id, () => ticks.dispose())
  }

  /** After each sample: its four tables read back, then the checks and tiles. A newer sample's read wins. */
  private async read(id: string, status: readonly { readonly id: string; readonly value: number | string }[]): Promise<void> {
    const handle = this.handles.get(id)
    if (!handle) return
    const read = (this.reads.get(id) ?? 0) + 1
    this.reads.set(id, read)
    const [jobs, alerts, schedules, reads] = await Promise.all([0, 1, 2, 3].map(table => rowsOf(handle.table(agentOverviewProbe, table), table)))
    if (this.reads.get(id) !== read || !this.get(id) || this.disposed) return
    const facts = factsOfRows(status, jobs!, alerts!, schedules!, reads!)
    this.patch(id, { facts, checks: overviewChecks(facts), tiles: overviewTiles(facts) })
  }

  private following(): void {
    for (const state of Object.values(this.getSnapshot().documents)) {
      const connectionId = this.options.documents.get(state.id)?.connectionId
      if (connectionId !== state.connectionId) this.patch(state.id, { connectionId, notice: undefined })
    }
  }

  /** Check again: a sample now. */
  refresh(id: string): void { if (this.live(id)) this.handles.get(id)?.refresh() }
  isLive(id: string): boolean { return this.live(id) }

  /** How the view ended, when it failed (the probe itself never fails on a refused read; those are reads table rows). */
  ended(id: string): { readonly code?: string; readonly message: string } | undefined {
    const snapshot = this.handles.get(id)?.getSnapshot()
    const probe = snapshot?.probes[agentOverviewProbe]
    if (snapshot?.status !== 'ended') return probe?.error && (probe.state === 'failing' || probe.state === 'stale') ? { code: probe.error.code, message: probe.error.message } : undefined
    if (snapshot.ended ? snapshot.ended.ended !== 'failed' : !snapshot.error) return undefined
    const code = snapshot.ended?.code ?? snapshot.error?.code
    return { ...code ? { code } : {}, message: snapshot.ended?.message ?? snapshot.error?.message ?? agentOverviewText.failed }
  }

  /** Runs a check's fix through its owning surface. */
  async fix(id: string, action: OverviewFix): Promise<void> {
    const connectionId = this.live(id) ? this.get(id)?.connectionId : undefined
    if (!connectionId) { this.patch(id, { notice: agentOverviewText.notConnected }); return }
    this.patch(id, { notice: undefined })
    const fixes = this.options.fixes
    try {
      switch (action.kind) {
        case 'failedJobs': fixes.failedJobs(connectionId); break
        case 'changeOwner': await fixes.changeOwner(connectionId, action.jobs); break
        case 'notifications': fixes.openJob(connectionId, action.job, 'notifications'); break
        case 'agentProperties': fixes.agentProperties(connectionId, 'history'); break
        case 'recommendedAlerts': fixes.recommendedAlerts(connectionId); break
        case 'schedules': fixes.schedules(connectionId); break
        case 'startAgent': await fixes.startAgent(connectionId); break
      }
    } catch (failure) { this.patch(id, { notice: failure instanceof Error ? failure.message : String(failure) }) }
  }
  /** A named object's link: a job opens its document, a schedule the Schedules document. */
  openObject(id: string, object: OverviewObject): void {
    const connectionId = this.live(id) ? this.get(id)?.connectionId : undefined
    if (!connectionId) { this.patch(id, { notice: agentOverviewText.notConnected }); return }
    try {
      if (object.kind === 'job') this.options.fixes.openJob(connectionId, object.name)
      else this.options.fixes.schedules(connectionId)
    } catch (failure) { this.patch(id, { notice: failure instanceof Error ? failure.message : String(failure) }) }
  }
  /** The header's Properties: SQL Server Agent Properties. */
  properties(id: string): void {
    const connectionId = this.live(id) ? this.get(id)?.connectionId : undefined
    if (!connectionId) { this.patch(id, { notice: agentOverviewText.notConnected }); return }
    try { this.options.fixes.agentProperties(connectionId) } catch (failure) { this.patch(id, { notice: failure instanceof Error ? failure.message : String(failure) }) }
  }
  /** A KPI tile clicked: opens Job Activity Monitor (all, failed, or running) or Operators and Notifications. */
  openTile(id: string, tileId: OverviewTile['id']): void {
    const connectionId = this.live(id) ? this.get(id)?.connectionId : undefined
    if (!connectionId) { this.patch(id, { notice: agentOverviewText.notConnected }); return }
    this.patch(id, { notice: undefined })
    try {
      switch (tileId) {
        case 'jobs': this.options.fixes.jobsView?.(connectionId, 'all'); break
        case 'failed': this.options.fixes.failedJobs(connectionId); break
        case 'running': this.options.fixes.jobsView?.(connectionId, 'running'); break
        case 'alerts': this.options.fixes.alerts?.(connectionId); break
      }
    } catch (failure) { this.patch(id, { notice: failure instanceof Error ? failure.message : String(failure) }) }
  }

  private live(id: string): boolean {
    const connectionId = this.get(id)?.connectionId
    return this.targetBindings.matchesConnection(id, connectionId) && this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected'))
  }

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
    this.watches.get(id)?.()
    this.watches.delete(id)
    this.handles.get(id)?.dispose()
    this.handles.delete(id)
    this.reads.delete(id)
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

  private patch(id: string, patch: Partial<AgentOverviewState>): void {
    const state = this.get(id)
    if (!state || this.disposed) return
    const next = { ...state, ...patch } as AgentOverviewState & Record<string, unknown>
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key]
    this.put(next)
  }
  private put(state: AgentOverviewState): void { this.publish({ documents: { ...this.getSnapshot().documents, [state.id]: state } }) }
}
