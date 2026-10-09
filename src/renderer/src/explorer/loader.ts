import type { ApiResult, ExplorerChildrenResult, VariaApi } from '../../../shared/contracts'
import { explorerLimits } from '../../../shared/explorer/catalog.ts'
import type { ExplorerChildrenParams } from '../../../shared/explorer/refs.ts'
import { onUnexpectedError } from '../core/errors'
import { browserTimers, type Timers } from '../core/timers'
import type { Disposable } from '../core/types'
import type { NodeError } from './tree-model'

export type LoadPriority = 'user' | 'background'
/** One page of one node's children; `generation` is the node's, so a load for an older state is told apart. */
export interface LoadRequest {
  readonly connectionId: string
  readonly nodeId: number
  readonly generation: number
  readonly params: Omit<ExplorerChildrenParams, 'connectionId' | 'requestId'>
}
export type LoadOutcome =
  | { readonly ok: true; readonly result: ExplorerChildrenResult }
  /** A request that failed before it produced a page; `connectionLost` marks the server row. */
  | { readonly ok: false; readonly error: NodeError; readonly connectionLost: boolean }
export interface LoadTask extends LoadRequest {
  readonly requestId: string
  readonly seq: number
  readonly priority: LoadPriority
  readonly state: 'queued' | 'running' | 'settled' | 'aborted'
}
/** Numbers from `explorerLimits` (tests lower them). */
export type ExplorerLimitValues<K extends keyof typeof explorerLimits> = { readonly [P in K]: number }
export type LoaderLimits = ExplorerLimitValues<'inFlightPerConnection' | 'inFlightTotal' | 'queuePerConnection' | 'cancelBatch' | 'watchdogMs'>
export interface LoaderOptions {
  readonly api: Pick<VariaApi, 'explorerChildren' | 'explorerCancel'>
  readonly timers?: Timers
  /** When pending cancels are sent together: a microtask by default, so they never wait for a hidden window's frames. */
  readonly schedule?: (callback: () => void) => void
  readonly newId?: () => string
  readonly limits?: Partial<LoaderLimits>
  /** Hears every change in the number of pending (queued or running) tasks. */
  readonly onPendingChange?: () => void
}

export const queueFullMessage = 'Too many pending Object Explorer requests.'
const watchdogMessage = (ms: number) => `Object Explorer did not answer within ${Math.round(ms / 1000)} seconds.`
/** Envelope failures that mean the server, not the node, is unreachable. */
const lostCodes: ReadonlySet<string> = new Set(['NOT_CONNECTED', 'CONNECTION_LOST', 'BACKEND_LOST', 'BACKEND_UNAVAILABLE'])
/** What a failed `explorer.children` envelope means for the node: a lost connection, a timeout, or an error row. */
export function envelopeOutcome(result: { readonly error: string; readonly code?: string }): LoadOutcome & { ok: false } {
  const connectionLost = !!result.code && lostCodes.has(result.code)
  const code = connectionLost ? 'CONNECTION_LOST' : result.code === 'TIMEOUT' ? 'TIMEOUT' : 'REQUEST_FAILED'
  return { ok: false, error: { code, message: result.error, retryable: true }, connectionLost }
}

interface Entry {
  task: { -readonly [K in keyof LoadTask]: LoadTask[K] }
  readonly key: string
  readonly done: (outcome: LoadOutcome) => void
  watchdog?: unknown
  /** The slot it holds was given back (it settled, or its watchdog fired). */
  released: boolean
}
class ConnectionQueue {
  readonly user: Entry[] = []
  readonly background: Entry[] = []
  running = 0
  get queued(): number { return this.user.length + this.background.length }
}

/**
 * Sends Object Explorer loads: at most 4 per connection and 8 in all, user loads before background ones (FIFO within a
 * priority), deduplicated by (connection, node, cursor, generation), and at most 512 queued per connection. Aborting a
 * queued task sends nothing; aborting a running one adds its requestId to one `explorerCancel` per tick, so Collapse All
 * or a disconnect sends one call. An aborted task never settles; every other task settles exactly once, asynchronously.
 */
export class ExplorerLoader implements Disposable {
  private readonly api: LoaderOptions['api']
  private readonly timers: Timers
  private readonly schedule: (callback: () => void) => void
  private readonly newId: () => string
  private readonly limits: LoaderLimits
  private readonly onPendingChange?: () => void
  private readonly queues = new Map<string, ConnectionQueue>()
  private readonly live = new Map<string, Entry>()
  private readonly entries = new WeakMap<LoadTask, Entry>()
  private running = 0
  private seq = 0
  private cancels: string[] = []
  private cancelScheduled = false
  private disposed = false

  constructor(options: LoaderOptions) {
    this.api = options.api
    this.timers = options.timers ?? browserTimers
    this.schedule = options.schedule ?? queueMicrotask
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.limits = { ...explorerLimits, ...options.limits }
    this.onPendingChange = options.onPendingChange
  }

  /** Queued or running tasks that were not aborted. */
  get pending(): number { return this.live.size }
  /** Requests sent and not yet answered, aborted ones included: they hold their slot until the backend answers. */
  get inFlight(): number { return this.running }

  /**
   * Queues a load. A duplicate of a pending task returns that task (moving it up to user priority), and `done` is not
   * kept. A full queue first drops its oldest background task; a background task, or a user task when none can be
   * dropped, is refused with an error outcome.
   */
  enqueue(request: LoadRequest, priority: LoadPriority, done: (outcome: LoadOutcome) => void): LoadTask {
    const key = `${request.connectionId}\u0000${request.nodeId}\u0000${request.params.cursor ?? ''}\u0000${request.generation}`
    const existing = this.live.get(key)
    if (existing) {
      if (priority === 'user' && existing.task.state === 'queued' && existing.task.priority === 'background') {
        const queue = this.queueFor(existing.task.connectionId)
        queue.background.splice(queue.background.indexOf(existing), 1)
        existing.task.priority = 'user'
        queue.user.push(existing)
        queue.user.sort((a, b) => a.task.seq - b.task.seq)
        this.pump()
      }
      return existing.task
    }
    const entry: Entry = { task: { ...request, requestId: this.newId(), seq: ++this.seq, priority, state: 'queued' }, key, done, released: true }
    this.entries.set(entry.task, entry)
    if (this.disposed) { entry.task.state = 'aborted'; return entry.task }
    const queue = this.queueFor(request.connectionId)
    if (queue.queued >= this.limits.queuePerConnection) {
      const victim = priority === 'user' ? queue.background.shift() : undefined
      if (!victim) { this.refuse(entry); return entry.task }
      this.live.delete(victim.key)
      this.refuse(victim)
    }
    queue[priority].push(entry)
    this.live.set(key, entry)
    this.pendingChanged()
    this.pump()
    return entry.task
  }

  /** Drops a task: a queued one sends nothing; a running one is cancelled with the next batch. */
  abort(task: LoadTask): void {
    const entry = this.entries.get(task)
    if (!entry || (entry.task.state !== 'queued' && entry.task.state !== 'running')) return
    if (this.live.get(entry.key) === entry) this.live.delete(entry.key)
    if (entry.task.state === 'queued') {
      const queue = this.queueFor(task.connectionId), list = queue[entry.task.priority]
      list.splice(list.indexOf(entry), 1)
    } else this.cancel(entry.task.requestId)
    entry.task.state = 'aborted'
    this.pendingChanged()
  }
  /** Aborts every pending task `predicate` accepts; returns how many. */
  abortWhere(predicate: (task: LoadTask) => boolean): number {
    let count = 0
    for (const entry of [...this.live.values()]) if (predicate(entry.task)) { this.abort(entry.task); count++ }
    return count
  }

  dispose(): void {
    if (this.disposed) return
    this.abortWhere(() => true)
    this.disposed = true
    this.flushCancels()
    for (const queue of this.queues.values()) queue.user.length = queue.background.length = 0
  }

  private queueFor(connectionId: string): ConnectionQueue {
    let queue = this.queues.get(connectionId)
    if (!queue) { queue = new ConnectionQueue(); this.queues.set(connectionId, queue) }
    return queue
  }

  private pendingChanged(): void {
    if (!this.onPendingChange) return
    try { this.onPendingChange() } catch (error) { onUnexpectedError(error) }
  }

  private refuse(entry: Entry): void {
    entry.task.state = 'settled'
    this.deliver(entry, { ok: false, error: { code: 'REQUEST_FAILED', message: queueFullMessage, retryable: true }, connectionLost: false })
  }

  private deliver(entry: Entry, outcome: LoadOutcome): void {
    queueMicrotask(() => { try { entry.done(outcome) } catch (error) { onUnexpectedError(error) } })
  }

  /** Starts the oldest task of the highest priority whose connection has a free slot, while slots remain. */
  private pump(): void {
    while (!this.disposed && this.running < this.limits.inFlightTotal) {
      const next = this.pick('user') ?? this.pick('background')
      if (!next) return
      this.start(next)
    }
  }
  private pick(priority: LoadPriority): Entry | undefined {
    let best: ConnectionQueue | undefined
    for (const queue of this.queues.values()) {
      const head = queue[priority][0]
      if (head && queue.running < this.limits.inFlightPerConnection && (!best || head.task.seq < best[priority][0].task.seq)) best = queue
    }
    return best?.[priority].shift()
  }

  private start(entry: Entry): void {
    const { task } = entry, queue = this.queueFor(task.connectionId)
    task.state = 'running'
    entry.released = false
    queue.running++
    this.running++
    entry.watchdog = this.timers.setTimeout(() => this.expire(entry), this.limits.watchdogMs)
    let request: Promise<ApiResult<ExplorerChildrenResult>>
    try { request = this.api.explorerChildren({ ...task.params, connectionId: task.connectionId, requestId: task.requestId }) }
    catch (error) { request = Promise.reject(error) }
    request.then(result => this.finish(entry, result), (error: unknown) => this.finish(entry, { ok: false, error: error instanceof Error ? error.message : 'The request failed.' }))
  }

  private release(entry: Entry): void {
    if (entry.released) return
    entry.released = true
    this.timers.clearTimeout(entry.watchdog)
    this.queueFor(entry.task.connectionId).running--
    this.running--
  }

  private finish(entry: Entry, result: ApiResult<ExplorerChildrenResult>): void {
    const wasRunning = !entry.released
    this.release(entry)
    // Aborted (silent), or already settled by its watchdog.
    if (entry.task.state === 'running') {
      entry.task.state = 'settled'
      this.live.delete(entry.key)
      this.pendingChanged()
      this.deliver(entry, result.ok ? { ok: true, result: result.value } : envelopeOutcome(result))
    }
    if (wasRunning) this.pump()
  }

  /** A task without an answer for 60 s times out: it is cancelled, settles as TIMEOUT, and gives its slot back. */
  private expire(entry: Entry): void {
    entry.watchdog = undefined
    if (entry.released) return
    this.release(entry)
    if (entry.task.state === 'running') {
      entry.task.state = 'settled'
      this.live.delete(entry.key)
      this.cancel(entry.task.requestId)
      this.pendingChanged()
      this.deliver(entry, { ok: false, error: { code: 'TIMEOUT', message: watchdogMessage(this.limits.watchdogMs), retryable: true }, connectionLost: false })
    }
    this.pump()
  }

  private cancel(requestId: string): void {
    this.cancels.push(requestId)
    if (this.cancelScheduled || this.disposed) return
    this.cancelScheduled = true
    this.schedule(() => this.flushCancels())
  }
  private flushCancels(): void {
    this.cancelScheduled = false
    const ids = this.cancels
    this.cancels = []
    for (let start = 0; start < ids.length; start += this.limits.cancelBatch) {
      try {
        void this.api.explorerCancel(ids.slice(start, start + this.limits.cancelBatch)).then(result => { if (!result.ok) onUnexpectedError(new Error(result.error)) }, onUnexpectedError)
      } catch (error) { onUnexpectedError(error) }
    }
  }
}
