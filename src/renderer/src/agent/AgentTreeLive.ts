// SQL Server Agent's live Object Explorer node (AG-12, docs/sql-server-agent.md › Object Explorer). Two kinds of background
// live view per connection, both opened and closed by what the tree shows, never by a timer of their own:
//  - `agent.tree`: while a SQL Server Agent node is open and shown, its one probe fingerprints what the node lists. A change
//    of Agent XPs or the service state re-lists the node (its folders), and a changed fingerprint reloads only the folders
//    that show it, in the background, keeping expansion and selection, as the SSIS Catalog's tree does (SsisTreeProbe). The
//    first sample of a connection is a baseline unless the node was listed before the view opened (then it reloads all).
//  - `agent.jobs`: while a Jobs folder is open and shown, Job Activity Monitor's own list and service probes give each job
//    row its state chips (src/shared/explorer/status.ts agentJobChips), published by connection and job id. No second
//    polling path: the same probes, the same backend reader.
// Both pause with Object Explorer and the window (LiveService does that for their owner), both stop when the tree no longer
// shows what they feed, and a view that ended opens again after a growing back-off, unless it ended for good: then a Refresh
// of the server or of the Agent node tries again.
import { agentLimits } from '../../../shared/agent/catalog'
import { agentAvailability, agentJobsProbe, agentJobsSource, agentServiceProbe, type AgentServiceSample } from '../../../shared/agent/jobs'
import { agentTreeChange, agentTreeFinalCodes, agentTreeFolders, agentTreeProbe, agentTreeRetryMs, agentTreeSource } from '../../../shared/agent/tree'
import type { FolderId } from '../../../shared/explorer/catalog'
import { agentJobChips, type StatusChip } from '../../../shared/explorer/status'
import { liveProbes } from '../../../shared/live/catalog'
import type { LiveTick } from '../../../shared/live/schema'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable, WorkbenchEvent } from '../core/types'
import type { ExplorerService, ReconcileOptions, TreeNode } from '../explorer/ExplorerService'
import { readRows, type RowStatus } from '../explorer/ExplorerStatusService'
import type { LiveHandle, LiveOwner, LiveService, LiveSettingsSource } from '../live/LiveService'

const background: ReconcileOptions = { background: true }
const finalCodes: ReadonlySet<string> = new Set(agentTreeFinalCodes)
/** The list's columns a chip reads, by their place in the catalogue (src/shared/live/catalog.ts). */
const jobColumns = Object.fromEntries(liveProbes[agentJobsProbe].tables![0].columns.map((column, index) => [column.id, index])) as Record<string, number>
const usable = new Set(['fresh', 'stale'])
/** The list's columns the chips read, so a revision read every few seconds while a job runs skips the rest. */
const jobSpan = (() => {
  const used = ['enabled', 'status', 'step', 'lastOutcome', 'jobId'].map(id => jobColumns[id])
  return { start: Math.min(...used), end: Math.max(...used) + 1 }
})()

/** A job row's live status: its chips, what they say, and whether the job is enabled as the read found it. */
export type AgentJobRowStatus = RowStatus
export interface AgentTreeSnapshot {
  /** Job rows' live status by connection, then by lower-case job id, while that connection's Jobs folder is open and its list samples. */
  readonly jobs: ReadonlyMap<string, ReadonlyMap<string, AgentJobRowStatus>>
}

/** Whether a node's row shows in Object Explorer: every node above it, up to its server, is expanded. */
function shownInExplorer(explorer: Pick<ExplorerService, 'node'>, node: TreeNode): boolean {
  for (let above = explorer.node(node.parent); above; above = above.parent ? explorer.node(above.parent) : undefined) if (!above.expanded) return false
  return true
}

export interface AgentTreeLiveOptions {
  readonly explorer: Pick<ExplorerService, 'subscribe' | 'rootIds' | 'node' | 'reconcile'>
  readonly live: Pick<LiveService, 'open'>
  /** Whether Object Explorer shows: the views pause while it does not. */
  readonly explorerVisible: { visible(): boolean; subscribe(listener: () => void): () => void; popout?(): boolean }
  /** Live status in Object Explorer (`liveData.explorerStatus`): off, neither view opens. */
  readonly settings: LiveSettingsSource
  /** The user's refreshes: one of the server or of the Agent node (or anything in it) opens a view that stopped again. */
  readonly events: { subscribe(listener: (event: WorkbenchEvent) => void): Disposable }
  readonly timers?: Timers
}

type Kind = 'tree' | 'jobs'
interface View { readonly handle: LiveHandle; readonly stops: (() => void)[] }
/** A connection's view that ended: when it opens again (after `timer`), or `final` when it will not until a Refresh. */
interface Stopped { attempts: number; timer: unknown; final: boolean }
/** A jobs view's last read: the rows by job id, the subscription they came from, and the newest read in flight. */
interface JobRead { subscriptionId?: string; at?: number; reading?: boolean; rows?: Map<string, { enabled: string | null; status: string | null; step: string | null; lastOutcome: string | null }>; seq: number; service?: AgentServiceSample }

export class AgentTreeLive extends SnapshotStore<AgentTreeSnapshot> implements Disposable {
  private readonly views = new Map<string, View>()
  private readonly stopped = new Map<string, Stopped>()
  /** The last fingerprints seen per connection (status id → value), kept while its server stays in the tree. */
  private readonly seen = new Map<string, ReadonlyMap<string, number | string>>()
  /** Connections whose Agent node was listed before their tree view opened: the first sample reloads it all, not a baseline. */
  private readonly late = new Set<string>()
  /** Nodes to reload whose listing, or one above or below them, was on its way when a change was seen. */
  private readonly settling = new Map<number, ReconcileOptions>()
  private readonly reads = new Map<string, JobRead>()
  private readonly stops: (() => void)[]
  private readonly timers: Timers
  private syncing = false
  private again = false
  private queued = false
  private disposed = false

  constructor(private readonly o: AgentTreeLiveOptions) {
    super({ jobs: new Map() })
    this.timers = o.timers ?? browserTimers
    const events = o.events.subscribe(event => this.guard(() => { if (event.type === 'explorer.refreshed') this.refreshed(event.connectionId, event.nodeId) }))
    this.stops = [
      o.explorer.subscribe(() => this.guard(() => { this.sync(); this.settled() })),
      o.settings.subscribe(() => this.guard(() => this.sync())),
      o.explorerVisible.subscribe(() => this.guard(() => this.sync())),
      () => events.dispose()
    ]
    this.sync()
  }

  /** The open views' keys ("tree:<connection>", "jobs:<connection>"), for the checks. */
  get keys(): readonly string[] { return [...this.views.keys()] }
  handle(kind: Kind, connectionId: string): LiveHandle | undefined { return this.views.get(kind + ':' + connectionId)?.handle }
  /** A job row's live status (the job id as the tree lists it), or undefined while its Jobs folder's view says nothing. */
  job(connectionId: string, jobId: string | undefined): AgentJobRowStatus | undefined {
    return jobId === undefined ? undefined : this.getSnapshot().jobs.get(connectionId)?.get(jobId.toLowerCase())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    for (const key of [...this.views.keys()]) this.close(key)
    for (const key of [...this.stopped.keys()]) this.forget(key)
    this.seen.clear()
    this.late.clear()
    this.settling.clear()
    this.clearListeners()
  }

  private guard(work: () => void): void {
    if (this.disposed) return
    try { work() } catch (error) { onUnexpectedError(error) }
  }

  private get enabled(): boolean { return this.o.settings.getSnapshot().values['liveData.explorerStatus'] }

  // --- What the tree shows ---------------------------------------------------------------------------------------------

  /** The SQL Server Agent nodes listed below a connection's servers. */
  private agents(connectionId: string): TreeNode[] {
    const nodes: TreeNode[] = []
    for (const id of this.o.explorer.rootIds) {
      const root = this.o.explorer.node(id)
      if (root?.connectionId !== connectionId || root.lost) continue
      for (const child of root.children ?? []) if (child.kind === 'agent') nodes.push(child)
    }
    return nodes
  }

  private folders(agent: TreeNode, folder: FolderId): TreeNode[] {
    return (agent.children ?? []).filter(child => child.kind === 'folder' && child.folder === folder)
  }

  /** Opens the views the tree needs and closes the others. A sync that opens something can cause another (the tree changed):
   *  it runs after this one rather than inside it. */
  private sync(): void {
    if (this.syncing) { this.again = true; return }
    this.syncing = true
    try {
      do { this.again = false; this.syncOnce() } while (this.again && !this.disposed)
    } finally { this.syncing = false }
  }

  private syncOnce(): void {
    const servers = new Set<string>(), wanted = new Set<string>()
    for (const id of this.o.explorer.rootIds) {
      const root = this.o.explorer.node(id)
      if (!root || root.lost) continue
      servers.add(root.connectionId)
      if (!this.enabled) continue
      for (const agent of this.agents(root.connectionId)) {
        if (!agent.expanded || !shownInExplorer(this.o.explorer, agent)) continue
        wanted.add('tree:' + root.connectionId)
        if (this.folders(agent, 'agentJobs').some(folder => folder.expanded)) wanted.add('jobs:' + root.connectionId)
      }
    }
    for (const key of [...this.views.keys()]) if (!wanted.has(key)) this.close(key)
    // A view whose node closed or hid waits for nothing: opening it again tries at once.
    for (const key of [...this.stopped.keys()]) if (!wanted.has(key)) this.forget(key)
    for (const connectionId of [...this.seen.keys()]) if (!servers.has(connectionId)) this.seen.delete(connectionId)
    for (const connectionId of [...this.late]) if (!servers.has(connectionId)) this.late.delete(connectionId)
    for (const key of wanted) {
      const stopped = this.stopped.get(key)
      if (!this.views.has(key) && !stopped?.final && stopped?.timer === undefined) this.open(key)
    }
  }

  private open(key: string): void {
    const at = key.indexOf(':'), kind = key.slice(0, at) as Kind, connectionId = key.slice(at + 1)
    if (kind === 'tree' && !this.seen.has(connectionId) && this.agents(connectionId).some(agent => (agent.children !== undefined || failedAgent(agent)) && agent.load !== 'loading')) this.late.add(connectionId)
    const owner: LiveOwner = {
      key: 'explorer:agent:' + key,
      visible: () => this.o.explorerVisible.visible(),
      popout: () => this.o.explorerVisible.popout?.() ?? false,
      // A server that left the tree, or lost its backend, ends the view; closing the node disposes it here.
      connectionId: () => this.o.explorer.rootIds.some(id => { const root = this.o.explorer.node(id); return root?.connectionId === connectionId && !root.lost }) ? connectionId : undefined,
      subscribe: listener => {
        const stopVisible = this.o.explorerVisible.subscribe(listener), stopExplorer = this.o.explorer.subscribe(listener)
        return () => { stopVisible(); stopExplorer() }
      }
    }
    const handle = kind === 'tree'
      ? this.o.live.open({ connectionId, source: agentTreeSource, probes: [{ probe: agentTreeProbe }], background: true }, owner)
      : this.o.live.open({ connectionId, source: agentJobsSource, probes: [{ probe: agentJobsProbe }, { probe: agentServiceProbe }], background: true }, owner)
    const view: View = { handle, stops: [] }
    this.views.set(key, view)
    const ticks = handle.onTick(({ subscriptionId, tick }) => this.guard(() => kind === 'tree' ? this.treeTick(connectionId, tick) : this.jobsTick(connectionId, handle, subscriptionId, tick)))
    view.stops.push(() => ticks.dispose(), handle.subscribe(() => this.guard(() => this.statusChanged(key, view))))
    if (kind === 'jobs') this.reads.set(connectionId, { seq: 0 })
    // LiveService answers a view it has no room for (too many in this window) as one that has already ended.
    this.statusChanged(key, view)
  }

  private close(key: string): void {
    const view = this.views.get(key)
    if (!view) return
    this.views.delete(key)
    for (const stop of view.stops.splice(0)) stop()
    view.handle.dispose()
    if (key.startsWith('jobs:')) {
      const connectionId = key.slice('jobs:'.length)
      this.reads.delete(connectionId)
      this.publishJobs()
    }
  }

  /** A view ended or was lost: it opens again after the back-off, or, ended for good, waits for a Refresh. */
  private statusChanged(key: string, view: View): void {
    if (this.views.get(key) !== view) return
    const snapshot = view.handle.getSnapshot()
    const connectionId = key.slice(key.indexOf(':') + 1)
    if (key.startsWith('tree:') && (snapshot.status === 'paused' || snapshot.status === 'dormant') && !this.seen.has(connectionId)) this.late.add(connectionId)
    if (key.startsWith('jobs:')) this.publishJobs()
    if (snapshot.status !== 'ended' && snapshot.status !== 'lost') return
    this.close(key)
    const stopped = this.stopped.get(key) ?? { attempts: 0, timer: undefined, final: false }
    this.stopped.set(key, stopped)
    const code = snapshot.error?.code ?? snapshot.ended?.code
    if (code && finalCodes.has(code)) stopped.final = true
    else {
      const delay = Math.min(agentTreeRetryMs.max, agentTreeRetryMs.first * 2 ** Math.min(stopped.attempts, 16))
      stopped.attempts++
      stopped.timer = this.timers.setTimeout(() => this.guard(() => { stopped.timer = undefined; this.sync() }), delay)
    }
  }

  /** The user refreshed the server, the Agent node or something in it: a view of that connection that stopped tries again. */
  private refreshed(connectionId: string, nodeId: number): void {
    const keys = ['tree:' + connectionId, 'jobs:' + connectionId].filter(key => this.stopped.has(key))
    if (!keys.length) return
    const refreshed = this.o.explorer.node(nodeId)
    if (refreshed?.connectionId !== connectionId) return
    let related = refreshed.parent === 0
    for (let node: TreeNode | undefined = refreshed; node && !related; node = node.parent ? this.o.explorer.node(node.parent) : undefined) related = node.kind === 'agent'
    if (!related) return
    for (const key of keys) this.forget(key)
    this.sync()
  }

  private forget(key: string): void {
    const stopped = this.stopped.get(key)
    if (!stopped) return
    this.stopped.delete(key)
    if (stopped.timer !== undefined) this.timers.clearTimeout(stopped.timer)
  }

  // --- agent.tree: what to reload -------------------------------------------------------------------------------------

  private treeTick(connectionId: string, tick: LiveTick): void {
    const status = tick.samples.find(sample => sample.probe === agentTreeProbe)?.status
    if (!status) {
      if (!this.seen.has(connectionId)) this.late.add(connectionId)
      return
    }
    // A view that samples has room: its next end starts the back-off over.
    this.stopped.delete('tree:' + connectionId)
    const next = new Map(status.map(value => [value.id, value.value]))
    const previous = this.seen.get(connectionId)
    this.seen.set(connectionId, next)
    if (!previous) {
      if (this.late.delete(connectionId)) this.reload(connectionId, true, agentTreeFolders)
      return
    }
    const change = agentTreeChange(previous, next)
    if (change.node || change.folders.length) this.reload(connectionId, change.node, change.folders)
  }

  /** Reconciles, in the background, the connection's Agent nodes (their folders) and the listed folders below them. */
  private reload(connectionId: string, node: boolean, folders: readonly FolderId[]): void {
    const wanted = new Set(folders)
    // A node whose listing is on its way, or one above or below it, may have read msdb before the change: it reconciles once
    // they all settle, so the user's own load is not restarted behind a background one.
    const reconcile = (target: TreeNode, options: ReconcileOptions): void => {
      if (this.busy(target)) {
        const waiting = this.settling.get(target.id)
        this.settling.set(target.id, waiting?.deep ? waiting : options)
      } else if (target.children !== undefined || failedAgent(target)) this.o.explorer.reconcile(target.id, options)
    }
    for (const agent of this.agents(connectionId)) {
      if (node) reconcile(agent, background)
      const visit = (parent: TreeNode): void => {
        for (const child of parent.children ?? []) {
          if (child.kind !== 'folder' || !child.folder) continue
          // One reconcile per subtree: a folder to reload above another reloads deeply, which covers the one below.
          if (wanted.has(child.folder)) reconcile(child, [...wanted].some(other => other !== child.folder && this.below(child, other)) || child.folder === 'agentProxies' ? { ...background, deep: true } : background)
          else visit(child)
        }
      }
      visit(agent)
    }
  }

  /** Whether a listed folder of this id lies below the node. */
  private below(node: TreeNode, folder: string): boolean {
    for (const child of node.children ?? []) {
      if (child.children === undefined) continue
      if (child.kind === 'folder' && child.folder === folder) return true
      if (this.below(child, folder)) return true
    }
    return false
  }

  /** Whether a page of the node, of a node above it or of a listed node below it is on its way. */
  private busy(node: TreeNode): boolean {
    for (let above = this.o.explorer.node(node.parent); above; above = above.parent ? this.o.explorer.node(above.parent) : undefined) if (above.load === 'loading') return true
    const within = (current: TreeNode): boolean => current.load === 'loading' || (current.children ?? []).some(within)
    return within(node)
  }

  /** Reconciles the nodes waiting for listings that have now settled; one that stopped or failed lists afresh anyway. */
  private settled(): void {
    for (const [id, options] of [...this.settling]) {
      const node = this.o.explorer.node(id)
      if (node && this.busy(node)) continue
      this.settling.delete(id)
      if (node && (node.load === 'loaded' || failedAgent(node))) this.o.explorer.reconcile(id, options)
    }
  }

  // --- agent.jobs: the job rows' chips --------------------------------------------------------------------------------

  private jobsTick(connectionId: string, handle: LiveHandle, subscriptionId: string, tick: LiveTick): void {
    const read = this.reads.get(connectionId)
    if (!read) return
    // A new subscription (out of dormancy, after a slot came back) starts from nothing.
    if (read.subscriptionId !== subscriptionId) { read.subscriptionId = subscriptionId; read.rows = undefined; read.service = undefined }
    this.stopped.delete('jobs:' + connectionId)
    for (const sample of tick.samples) {
      if (sample.probe === agentServiceProbe) {
        const value = (id: string) => { const entry = sample.status?.find(item => item.id === id); return typeof entry?.value === 'number' ? entry.value : undefined }
        const agentXps = value('agentXps'), serviceState = value('serviceState'), startupType = value('startupType')
        read.service = { ...agentXps !== undefined ? { agentXps } : {}, ...serviceState !== undefined ? { serviceState } : {}, ...startupType !== undefined ? { startupType } : {} }
        // Agent usable again while the list stopped on AGENT_DISABLED (it may have restarted between two service samples): read again.
        if (agentAvailability(read.service) === 'running' && handle.getSnapshot().probes[agentJobsProbe]?.error?.code === 'AGENT_DISABLED') handle.refresh()
        continue
      }
      if (sample.probe !== agentJobsProbe) continue
      const entry = sample.tables?.find(table => table.table === 0)
      if (!entry) continue
      // An unchanged revision needs no read: its rows are the ones already read, now as of this sample (unless a read of a
      // newer revision is on its way, which dates them itself).
      if (entry.diff && entry.diff.added + entry.diff.removed + entry.diff.changed === 0 && read.rows) {
        if (!read.reading) read.at = tick.sampledAt
        continue
      }
      this.readJobs(connectionId, handle, read, subscriptionId, tick.sampledAt)
    }
    this.publishJobs()
  }

  private readJobs(connectionId: string, handle: LiveHandle, read: JobRead, subscriptionId: string, sampledAt: number): void {
    const table = handle.table(agentJobsProbe)
    if (!table) return
    const seq = ++read.seq
    read.reading = true
    const current = () => this.reads.get(connectionId) === read && read.seq === seq && read.subscriptionId === subscriptionId
    // Every job the list keeps, not only the explorer status tables' first 1,000.
    readRows(table, agentLimits.listRows, jobSpan).then(({ rows }) => {
      if (!current() || this.disposed) return
      read.reading = false
      read.at = sampledAt
      const cell = (row: (string | null)[], id: string) => row[jobColumns[id] - jobSpan.start]
      read.rows = new Map(rows.filter(row => cell(row, 'jobId')).map(row => [cell(row, 'jobId')!.toLowerCase(), {
        enabled: cell(row, 'enabled'), status: cell(row, 'status'), step: cell(row, 'step'), lastOutcome: cell(row, 'lastOutcome')
      }]))
      this.publishJobs()
    }, () => {
      // A revision released before it was read: the rows read before it are out of date, and the next revision is read whatever its diff says.
      if (!current()) return
      read.reading = false
      read.rows = undefined
      this.publishJobs()
    })
  }

  /** When each listed job row of the connection was listed, by job id in lower case. */
  private listedAt(connectionId: string): Map<string, number> {
    const listed = new Map<string, number>()
    const visit = (node: TreeNode): void => {
      for (const child of node.children ?? []) {
        if (child.kind === 'agentJob') { if (child.jobId && child.listedAt !== undefined) listed.set(child.jobId.toLowerCase(), child.listedAt) }
        else if (child.kind === 'folder' && child.folder === 'agentJobs') visit(child)
      }
    }
    for (const agent of this.agents(connectionId)) visit(agent)
    return listed
  }

  /** Publishes every jobs view's chips, coalesced to one publication per microtask. */
  private publishJobs(): void {
    if (this.queued || this.disposed) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      if (this.disposed) return
      const previous = this.getSnapshot().jobs
      const jobs = new Map<string, ReadonlyMap<string, AgentJobRowStatus>>()
      for (const [connectionId, read] of this.reads) {
        const handle = this.views.get('jobs:' + connectionId)?.handle
        const snapshot = handle?.getSnapshot()
        const live = (snapshot?.status === 'live' || snapshot?.status === 'paused') && snapshot.subscriptionId === read.subscriptionId
        const list = snapshot?.probes[agentJobsProbe]
        // A list stopped because Agent XPs went off (Agent's own stop sets it to 0) keeps its last rows for what stays true
        // with Agent stopped (a failed last run, a disabled job), not what it was doing.
        const disabled = list?.state === 'failing' && list.error?.code === 'AGENT_DISABLED'
        if (!read.rows || !live || !(usable.has(list?.state ?? '') || disabled)) continue
        const availability = agentAvailability(read.service)
        const current = !disabled && (availability === 'running' || availability === 'pending')
        const before = previous.get(connectionId)
        const statuses = new Map<string, AgentJobRowStatus>()
        let same = !!before
        const listed = this.listedAt(connectionId)
        for (const [id, row] of read.rows) {
          const { chips, enabled } = agentJobChips(row, current)
          const old = before?.get(id)
          // The same status, unless its read lost to a newer listing that this read is newer than (liveJob compares them).
          const at = listed.get(id)
          const outdated = old?.enabledAt !== undefined && at !== undefined && old.enabledAt <= at && read.at !== undefined && read.at > at
          const status = old && !outdated && old.enabled === enabled && sameChips(old.chips, chips) ? old : jobStatus(chips, enabled, read.at)
          if (status !== old) same = false
          statuses.set(id, status)
        }
        jobs.set(connectionId, same && before!.size === statuses.size ? before! : statuses)
      }
      if (jobs.size === previous.size && [...jobs].every(([id, map]) => previous.get(id) === map)) return
      this.publish({ jobs })
    })
  }
}

/** An expanded Agent node whose listing failed with no rows to keep (first listed with Agent XPs off): a state change lists it again. */
const failedAgent = (node: TreeNode): boolean => node.kind === 'agent' && node.load === 'error' && node.expanded

const jobStatus = (chips: readonly StatusChip[], enabled: boolean | undefined, at: number | undefined): AgentJobRowStatus =>
  ({ chips, live: true, words: chips.map(chip => chip.words).join(', '), ...enabled !== undefined ? { enabled, ...at !== undefined ? { enabledAt: at } : {} } : {} })
const sameChips = (left: readonly StatusChip[], right: readonly StatusChip[]) => left.length === right.length && left.every((chip, at) => {
  const other = right[at]
  return chip.id === other.id && chip.tone === other.tone && chip.label === other.label && chip.title === other.title && chip.words === other.words && chip.icon === other.icon
})
