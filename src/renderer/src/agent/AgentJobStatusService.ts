// The status bar's running SQL Server Agent jobs (AG-3, docs/sql-server-agent.md): a job this window started is followed
// until it ends, through the agent.jobs source's watched and service probes, in a view that keeps sampling while the window
// is hidden (whileHidden statusOnly), so its end is still seen. Each connection has one view whose args name its followed jobs
// by slot; a change of the followed jobs opens a new view, so a sample's slots always mean the jobs that view was opened with.
// The backend schedules every read; nothing here polls.
import type { ApiResult, VariaApi } from '../../../shared/contracts'
import type { ActionExecuteResult } from '../../../shared/actions/schema'
import { agentLimits } from '../../../shared/agent/catalog'
import {
  agentAvailability, agentJobsSource, agentServiceProbe, agentWatchedProbe, stampMinus, watchedPhase, watchedServerNow, watchedSlot,
  type AgentAvailability, type AgentServiceSample, type WatchedJob, type WatchedPhase
} from '../../../shared/agent/jobs'
import { liveProbes } from '../../../shared/live/catalog'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { LiveHandle, LiveService } from '../live/LiveService'
import type { LiveConnection } from '../services/connections'

/** A job the status bar follows or shows the end of. */
export interface WatchedEntry {
  readonly key: string
  readonly connectionId: string
  readonly server: string
  readonly id: string
  readonly name: string
  readonly created: string
  readonly job: WatchedJob
  readonly phase: WatchedPhase
  /** When the Start was sent (performance.now(), a monotonic clock): with a sample's server clock, the Start's time in server time. */
  readonly watchedAt: number
  /** A Stop Job is on its way for it. */
  readonly stopping?: true
  readonly error?: string
}
export interface AgentJobStatusSnapshot {
  /** Newest first. */
  readonly jobs: readonly WatchedEntry[]
  /** Agent's state on each connection a view follows jobs on (the service probe's last sample). */
  readonly agent: Readonly<Record<string, AgentAvailability>>
}

export interface AgentJobStatusServiceOptions {
  readonly api: Pick<VariaApi, 'executeObjectAction'>
  readonly live: Pick<LiveService, 'open'>
  readonly connections: ExternalStore<readonly LiveConnection[]>
  readonly newId?: () => string
  readonly now?: () => number
}

/** A grid's yyyy-MM-dd HH:mm:ss (server time) as yyyymmddhhmmss; 0 for '' (never ran). */
export function stampOf(text: string): number {
  const digits = text.replace(/\D/g, '').slice(0, 14)
  return digits.length === 14 ? Number(digits) : 0
}
const active = (entry: WatchedEntry) => entry.phase.phase === 'starting' || entry.phase.phase === 'running'

export class AgentJobStatusService extends SnapshotStore<AgentJobStatusSnapshot> implements Disposable {
  private readonly newId: () => string
  private readonly now: () => number
  /** Each connection's view and the job keys its slots name, in order. */
  private readonly views = new Map<string, { readonly handle: LiveHandle; readonly slots: readonly string[]; readonly waiting: boolean; readonly stop: () => void }>()
  private readonly services = new Map<string, AgentServiceSample>()
  /** Agent's last read state per connection, kept across views (services is cleared when a view reopens). */
  private readonly lastKnown = new Map<string, AgentAvailability>()
  private readonly stopConnections: () => void
  private disposed = false

  constructor(private readonly options: AgentJobStatusServiceOptions) {
    super({ jobs: [], agent: {} })
    this.newId = options.newId ?? (() => crypto.randomUUID())
    // Monotonic: a client clock step between the Start and the first sample must not move the Start's server time.
    this.now = options.now ?? (() => performance.now())
    // A closed or lost connection ends its jobs' following: their outcome is unknown from here.
    this.stopConnections = options.connections.subscribe(() => { try { this.connectionsChanged() } catch (failure) { onUnexpectedError(failure) } })
  }

  /** A job Job Activity Monitor started: followed from its last run before the start (a run counts only above it). */
  watch(connectionId: string, job: { readonly id: string; readonly name: string; readonly created: string; readonly lastRun: string }, sentAt?: number): void {
    if (this.disposed) return
    const connection = this.options.connections.getSnapshot().find(item => item.id === connectionId)
    if (!connection) return
    const id = job.id.toLowerCase()
    const others = this.getSnapshot().jobs.filter(entry => !(entry.connectionId === connectionId && entry.id === id))
    const entry: WatchedEntry = {
      key: this.newId(), connectionId, server: connection.displayName || connection.server, id, name: job.name, created: job.created,
      job: { before: stampOf(job.lastRun), idleSamples: 0, seenRunning: false }, phase: { phase: 'starting' }, watchedAt: sentAt ?? this.now()
    }
    // At most agentLimits.watchedJobs followed per connection: the oldest still followed gives its slot up.
    const followed = others.filter(item => item.connectionId === connectionId && active(item))
    // As many ended items are kept, so the list and its +N tooltip stay bounded: the oldest ended goes.
    const ended = others.filter(item => item.connectionId === connectionId && !active(item))
    const dropped = new Set([...followed.slice(agentLimits.watchedJobs - 1), ...ended.slice(agentLimits.watchedJobs)].map(item => item.key))
    // Lost while the Start was answered: nothing can follow it, so its outcome is unknown from the start.
    const live = this.isLive(connectionId)
    this.publish({ ...this.getSnapshot(), jobs: [live ? entry : { ...entry, phase: { phase: 'unknown', reason: 'gone' } }, ...others.filter(item => !dropped.has(item.key))] })
    if (live) this.follow(connectionId)
  }

  /** Dismiss: the item goes; a job still running keeps running, unfollowed. */
  dismiss(key: string): void {
    const entry = this.getSnapshot().jobs.find(item => item.key === key)
    if (!entry) return
    this.publish({ ...this.getSnapshot(), jobs: this.getSnapshot().jobs.filter(item => item.key !== key) })
    this.follow(entry.connectionId)
  }

  /** Stop Job (AG-2's verb) on a followed job; its end shows when the next sample reads it. */
  async stop(key: string): Promise<void> {
    const entry = this.getSnapshot().jobs.find(item => item.key === key)
    if (!entry || entry.stopping || !active(entry)) return
    this.update(key, { stopping: true, error: undefined })
    let result: ApiResult<ActionExecuteResult> | undefined, failure: string | undefined
    try {
      result = await this.options.api.executeObjectAction({ action: 'stopJob', connectionId: entry.connectionId, requestId: this.newId(), target: { kind: 'agentJob', name: entry.name }, agentIdentity: { created: entry.created } })
    } catch (thrown) { failure = thrown instanceof Error ? thrown.message : String(thrown) }
    if (!failure && result && !result.ok) failure = result.error
    if (!failure && result?.ok && result.value.error) failure = result.value.error.message
    this.update(key, { stopping: undefined, ...failure ? { error: `Stop Job failed: ${failure}` } : {} })
    if (!failure) this.views.get(entry.connectionId)?.handle.refresh()
  }

  /** A job here ended because Agent stopped or its XPs went off, and still shows. */
  private agentEnded(connectionId: string): boolean {
    return this.getSnapshot().jobs.some(entry => entry.connectionId === connectionId && entry.phase.phase === 'unknown' && (entry.phase.reason === 'agentStopped' || entry.phase.reason === 'xpsOff'))
  }

  /**
   * The connection's view: the watched and service probes for its followed jobs; or, with none followed while a job Agent's
   * stop ended still shows, the service probe alone until Agent reads usable again, so "Agent stopped" never outlives it.
   */
  private follow(connectionId: string): void {
    const slots = this.getSnapshot().jobs.filter(entry => entry.connectionId === connectionId && active(entry)).slice(0, agentLimits.watchedJobs).map(entry => entry.key)
    const last = this.lastKnown.get(connectionId)
    const waiting = !slots.length && this.isLive(connectionId) && this.agentEnded(connectionId) && (last === 'stopped' || last === 'xpsOff')
    if (!this.isLive(connectionId)) this.lastKnown.delete(connectionId)
    const current = this.views.get(connectionId)
    if (current && current.waiting === waiting && current.slots.length === slots.length && current.slots.every((key, at) => key === slots[at])) return
    current?.stop()
    this.views.delete(connectionId)
    // A new view reads Agent's state afresh: a sample from an earlier one may be long out of date.
    this.services.delete(connectionId)
    this.publishAgent()
    if (!slots.length && !waiting) return
    const ids = slots.map(key => this.getSnapshot().jobs.find(entry => entry.key === key)!.id)
    let ended = false
    const owner = {
      key: 'agent-status:' + connectionId,
      visible: () => true,
      connectionId: () => this.isLive(connectionId) ? connectionId : undefined,
      closed: () => ended,
      subscribe: (listener: () => void) => this.options.connections.subscribe(listener)
    }
    const serviceProbe = { probe: agentServiceProbe, intervalMs: liveProbes[agentServiceProbe].intervalMs.default }
    const handle = this.options.live.open(waiting
      ? { connectionId, source: agentJobsSource, args: {}, whileHidden: 'statusOnly', probes: [serviceProbe] }
      : { connectionId, source: agentJobsSource, args: { watch: ids }, whileHidden: 'statusOnly', probes: [{ probe: agentWatchedProbe, intervalMs: liveProbes[agentWatchedProbe].intervalMs.default }, serviceProbe] }, owner)
    const ticks = handle.onTick(({ tick }) => {
      const service = tick.samples.find(sample => sample.probe === agentServiceProbe && sample.status)
      if (service?.status) {
        const value = (id: string) => { const entry = service.status!.find(item => item.id === id); return typeof entry?.value === 'number' ? entry.value : undefined }
        this.services.set(connectionId, { agentXps: value('agentXps'), serviceState: value('serviceState'), startupType: value('startupType') })
        this.lastKnown.set(connectionId, agentAvailability(this.services.get(connectionId)))
        this.publishAgent()
      }
      // Agent usable again: the service-only view has done its work.
      if (waiting) { if (agentAvailability(this.services.get(connectionId)) === 'running') queueMicrotask(() => this.follow(connectionId)); return }
      const watched = tick.samples.find(sample => sample.probe === agentWatchedProbe && sample.metrics)
      if (!watched && !service) return
      const availability = agentAvailability(this.services.get(connectionId))
      // Until the service probe has read Agent's state, a watched sample alone decides (Agent is usable when it reads).
      const effective = availability === 'pending' ? 'running' : availability
      if (!watched && effective === 'running') return
      let jobs = this.getSnapshot().jobs, changed = false
      const serverNow = watched ? watchedServerNow(watched.metrics) : undefined
      slots.forEach((key, slot) => {
        const entry = jobs.find(item => item.key === key)
        if (!entry || !active(entry)) return
        // The first clock dates the Start in server time: now less the time since the hand-over, and a second for rounding.
        const job = entry.job.requested === undefined && serverNow !== undefined
          ? { ...entry.job, requested: stampMinus(serverNow, Math.ceil((this.now() - entry.watchedAt) / 1000) + 1) } : entry.job
        const next = watchedPhase(job, watched ? watchedSlot(watched.metrics!, slot) : undefined, effective)
        if (!watched && next.phase.phase !== 'unknown') return
        if (JSON.stringify(next.phase) === JSON.stringify(entry.phase) && JSON.stringify(next.job) === JSON.stringify(entry.job)) return
        jobs = jobs.map(item => item.key === key ? { ...item, phase: next.phase, job: next.job } : item)
        changed = true
      })
      if (!changed) return
      this.publish({ ...this.getSnapshot(), jobs })
      // A job that ended frees its slot.
      if (slots.some(key => { const entry = jobs.find(item => item.key === key); return !entry || !active(entry) })) queueMicrotask(() => this.follow(connectionId))
    })
    // A view that ends on its own (refused, BUSY at the server's view limit) samples no more: its jobs' outcomes are unknown.
    const stopStatus = handle.subscribe(() => {
      if (ended || handle.getSnapshot().status !== 'ended') return
      queueMicrotask(() => this.viewEnded(connectionId, handle))
    })
    this.views.set(connectionId, { handle, slots, waiting, stop: () => { ended = true; stopStatus(); ticks.dispose(); handle.dispose() } })
  }

  private viewEnded(connectionId: string, handle: LiveHandle): void {
    const view = this.views.get(connectionId)
    if (this.disposed || view?.handle !== handle) return
    view.stop()
    this.views.delete(connectionId)
    if (view.waiting) { this.services.delete(connectionId); this.publishAgent(); return }
    const ended = new Set(view.slots)
    this.publish({ ...this.getSnapshot(), jobs: this.getSnapshot().jobs.map(entry => ended.has(entry.key) && active(entry) ? { ...entry, phase: { phase: 'unknown', reason: 'gone' } } : entry) })
    this.follow(connectionId)
  }

  private connectionsChanged(): void {
    let jobs = this.getSnapshot().jobs, changed = false
    for (const entry of jobs) {
      if (!active(entry) || this.isLive(entry.connectionId)) continue
      jobs = jobs.map(item => item.key === entry.key ? { ...item, phase: { phase: 'unknown', reason: 'gone' } } : item)
      changed = true
    }
    if (changed) this.publish({ ...this.getSnapshot(), jobs })
    for (const connectionId of [...this.views.keys()]) if (!this.isLive(connectionId)) this.follow(connectionId)
  }

  private isLive(connectionId: string): boolean {
    return this.options.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost && (!connection.lifecycle || connection.lifecycle.state === 'connected'))
  }
  private update(key: string, patch: Partial<WatchedEntry>): void {
    const jobs = this.getSnapshot().jobs.map(item => {
      if (item.key !== key) return item
      const next = { ...item, ...patch } as WatchedEntry & Record<string, unknown>
      for (const name of Object.keys(patch)) if (next[name] === undefined) delete next[name]
      return next
    })
    this.publish({ ...this.getSnapshot(), jobs })
  }
  private publishAgent(): void {
    const agent = Object.fromEntries([...this.services].map(([connectionId, sample]) => [connectionId, agentAvailability(sample)]))
    this.publish({ ...this.getSnapshot(), agent })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const view of this.views.values()) view.stop()
    this.views.clear()
    this.stopConnections()
    this.clearListeners()
  }
}
