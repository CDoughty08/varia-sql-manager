import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { z } from 'zod'
import type { BackendMethod, BackendMethods, BackendResultDescriptor, BackendState, LossReason, LostSummary, QueryEvent, ResultDescriptor } from '../../shared/contracts'
import { deadlineFor } from '../../shared/ipc/methods'
import { queryEventSchema, queryResultSchema } from '../../shared/ipc/port-messages'
import { PROTOCOL_VERSION, limits as wire, type CancelReason } from '../../shared/ipc/wire/protocol'
import { BackendConnection, systemClock, type BackendHello, type Clock, type ConnectionDeps, type Loss, type SendOptions, type SpawnSpec } from './connection'
import { BackendError, failureMessage, sentences } from './errors'

export interface RestartPolicy {
  /** Delay before the next generation after the 1st, 2nd, … unexpected loss (the last value repeats). */
  readonly delaysMs: readonly number[]
  /** This many unexpected losses within `breakerWindowMs` leave the backend failed until the user restarts it. */
  readonly breakerLosses: number
  readonly breakerWindowMs: number
  /** A generation that stays up this long resets the delays and the breaker. */
  readonly resetAfterMs: number
}
export const restartPolicy: RestartPolicy = wire.restart

/** Electron's powerMonitor: a sleeping laptop is not a silent backend. */
export interface PowerMonitorLike { on(event: 'suspend' | 'resume', listener: () => void): unknown }

export interface SupervisorDeps extends ConnectionDeps {
  policy?: Partial<RestartPolicy>
  /** Silence before the backend counts as unresponsive; smoke tests shorten it (VARIA_BACKEND_LIVENESS_MS). */
  unresponsiveMs?: number
  power?: PowerMonitorLike
}
export interface RequestOptions extends Pick<SendOptions, 'stream' | 'credit'> {
  /** Query events, validated and stamped with the generation; an invalid one fails the request (STREAM_PROTOCOL). */
  onEvent?: (event: QueryEvent) => void
  /** Only this generation may serve the request, and only while it is ready: results belong to one generation. */
  generation?: number
  /** The request's id once it is written, for CREDIT and CANCEL frames. */
  onSent?: (id: number) => void
}

const connectResultSchema = z.object({ id: z.string().min(1).max(128) }).loose()
const idOf = (params: unknown, key: 'connectionId' | 'sessionId'): string | undefined => {
  const value = params !== null && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value : undefined
}
const maxSessions = 4096

const stamp = (descriptor: BackendResultDescriptor, generation: number): ResultDescriptor => ({ ...descriptor, generation })

interface Retired { readonly generation: number; readonly reason: string; readonly loss?: Loss; readonly uptimeMs: number; readonly hello?: BackendHello; readonly connection?: BackendConnection }
interface Waiter { resolve(connection: BackendConnection): void; reject(error: BackendError): void }

/**
 * Owns the backend process across generations. A request is bound to the generation that is current when it is made
 * (or to the next one while a restart is pending) and is written to that generation only: nothing is ever re-sent.
 * A generation that exits or breaks the protocol is replaced after a short delay, until losses repeat too quickly; its
 * connections become lost and only an explicit Reconnect replaces them. A generation that is alive but silent is only
 * reported as unresponsive: restarting it would roll back every open transaction, so that is the user's decision.
 */
export class BackendSupervisor {
  private readonly spec: SpawnSpec
  private readonly deps: SupervisorDeps
  private readonly clock: Clock
  private readonly policy: RestartPolicy
  private readonly unresponsiveMs: number
  private readonly tickMs: number
  private readonly yieldTurn: (callback: () => void) => void
  private readonly listeners = new Set<(state: BackendState) => void>()
  private readonly waiting: Waiter[] = []
  /** Connection ids by generation; a loss moves them to `lost`, which is bounded and oldest-first. */
  private readonly live = new Map<string, number>()
  private readonly lost = new Set<string>()
  /** Query session ids by the generation their last script ran on. */
  private readonly sessions = new Map<string, number>()
  private connection: BackendConnection | undefined
  /** Closes of generations that a restart replaced; stop() waits for them too, so none outlives the app. */
  private readonly retiring = new Set<Promise<void>>()
  private generation = 0
  private snapshot: BackendState = { status: 'stopped' }
  private started = false
  private closing = false
  private stopping: Promise<void> | undefined
  private restartTimer: unknown
  /** Unexpected losses since the counters were last reset, and when each happened (for the breaker). */
  private attempts = 0
  private losses: number[] = []
  private readySince: number | undefined
  private retired: Retired | undefined
  private watchdogTimer: unknown
  private expectedTick = 0
  private windowStart = 0
  private suspended = false

  constructor(spec: SpawnSpec, deps: SupervisorDeps = {}) {
    this.spec = spec
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    this.policy = { ...restartPolicy, ...deps.policy }
    this.unresponsiveMs = deps.unresponsiveMs ?? wire.timers.unresponsiveMs
    this.tickMs = Math.max(25, Math.min(1000, Math.floor(this.unresponsiveMs / 4)))
    this.yieldTurn = deps.yieldTurn ?? (callback => { setImmediate(callback) })
    deps.power?.on('suspend', () => { this.suspended = true })
    deps.power?.on('resume', () => { this.suspended = false; this.windowStart = this.clock.now() })
  }

  get state(): BackendState { return this.snapshot }
  /** The current generation's connection, for tests and diagnostics. */
  get current(): BackendConnection | undefined { return this.connection }
  /** Connections that a restart would close. */
  connectionCount(): number { return this.live.size }
  isLostConnection(id: string): boolean { return this.lost.has(id) }

  onState(listener: (state: BackendState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(): void {
    if (this.started || this.closing) return
    this.started = true
    this.launch()
  }

  /** The generation whose results can be read now: the current one while it is ready. */
  get readyGeneration(): number | undefined { return this.connection?.isReady ? this.connection.generation : undefined }

  async request<M extends BackendMethod>(method: M, params: BackendMethods[M]['params'], o: RequestOptions = {}): Promise<BackendMethods[M]['result']> {
    this.start()
    const local = this.answerLocally(method, params)
    if (local) return local.value as BackendMethods[M]['result']
    if (o.generation !== undefined && this.readyGeneration !== o.generation) throw new BackendError('RESULT_UNAVAILABLE', sentences.resultUnavailable)
    const connection = this.connection ?? await this.upcoming()
    const sessionId = method === 'query.execute' ? idOf(params, 'sessionId') : undefined
    if (sessionId !== undefined) {
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, connection.generation)
      if (this.sessions.size > maxSessions) this.sessions.delete(this.sessions.keys().next().value!)
    }
    const onEvent = o.onEvent
    const sent = connection.send(method, params, {
      ...deadlineFor(method, params), stream: o.stream, credit: o.credit,
      onEvent: onEvent && (raw => {
        const parsed = queryEventSchema.safeParse(raw)
        if (!parsed.success) return false
        const event = parsed.data
        onEvent(event.type === 'resultSet.opened' || event.type === 'resultSet.closed' ? { ...event, descriptor: stamp(event.descriptor, connection.generation) } : event)
      })
    })
    if (sent.id) o.onSent?.(sent.id)
    const result = await sent.done
    return this.registered(method, params, result, connection) as BackendMethods[M]['result']
  }

  /** More credit for a results.read stream of `generation`, if that generation is still current. */
  credit(generation: number, id: number, bytes: number): void {
    if (this.connection?.generation === generation) this.connection.credit(id, bytes)
  }

  cancel(generation: number, id: number, reason: CancelReason): void {
    if (this.connection?.generation === generation) this.connection.cancel(id, reason)
  }

  /** Ends the current generation (its sessions end with it) and starts the next one at once. A manual restart also
   *  resets the breaker and recovers a failed backend; a reload leaves a failed backend to the user. */
  async restart(reason: 'reload' | 'manual'): Promise<void> {
    if (this.closing) return
    if (!this.started) return this.start()
    if (reason === 'reload' && this.snapshot.status === 'failed') return
    if (reason === 'manual') { this.attempts = 0; this.losses = [] }
    this.clock.clearTimeout(this.restartTimer)
    const previous = this.connection
    this.connection = undefined
    this.stopWatchdog()
    if (previous) this.setState({ status: 'restarting', generation: previous.generation, lost: this.retire(previous, reason), retryInMs: 0 })
    this.launch()
    if (!previous) return
    const closed = previous.close(undefined, reason === 'reload' ? new BackendError('BACKEND_LOST', sentences.reloaded) : undefined)
    this.retiring.add(closed)
    try { await closed } finally { this.retiring.delete(closed) }
  }

  /** Ends the backend for good; later calls wait for the same stop. */
  stop(): Promise<void> {
    return this.stopping ??= this.stopNow()
  }

  private async stopNow(): Promise<void> {
    const previous = this.connection
    this.closing = true
    this.connection = undefined
    this.clock.clearTimeout(this.restartTimer)
    this.stopWatchdog()
    const error = new BackendError('BACKEND_UNAVAILABLE', sentences.closing)
    for (const waiter of this.waiting.splice(0)) waiter.reject(error)
    if (this.snapshot.status !== 'stopped') this.setState({ status: 'stopped' })
    await Promise.all([previous?.close(undefined, error), ...this.retiring])
  }

  /** Requests that need no backend: cleanup of what a lost generation held, and refusals. */
  private answerLocally(method: BackendMethod, params: unknown): { value: unknown } | undefined {
    const unavailable = this.closing || this.snapshot.status === 'failed'
    const connectionId = idOf(params, 'connectionId')
    if (method === 'connections.disconnect' && (unavailable || (connectionId !== undefined && this.lost.has(connectionId)))) return { value: { disconnected: false } }
    if (method === 'query.session.close') {
      const sessionId = idOf(params, 'sessionId')
      const generation = sessionId === undefined ? undefined : this.sessions.get(sessionId)
      if (unavailable || (generation !== undefined && generation !== (this.connection?.generation ?? this.generation + 1))) {
        if (sessionId !== undefined) this.sessions.delete(sessionId)
        return { value: { closed: false } }
      }
    }
    if (unavailable) throw this.unavailable()
    if (connectionId !== undefined && this.lost.has(connectionId)) throw new BackendError('CONNECTION_LOST', sentences.connectionLost)
    return undefined
  }

  /** While a restart is pending, a request waits for (and is bound to) the next generation. */
  private upcoming(): Promise<BackendConnection> {
    if (this.waiting.length >= wire.pending.requests) return Promise.reject(new BackendError('TOO_MANY_REQUESTS', sentences.tooMany))
    return new Promise((resolve, reject) => { this.waiting.push({ resolve, reject }) })
  }

  private registered(method: BackendMethod, params: unknown, result: unknown, connection: BackendConnection): unknown {
    if (method === 'connections.connect') {
      const parsed = connectResultSchema.safeParse(result)
      if (!parsed.success) throw new BackendError('BACKEND_ERROR', sentences.invalid)
      // The generation may have ended between the answer and this continuation.
      if (this.connection === connection && !connection.lost) this.live.set(parsed.data.id, connection.generation)
      else this.markLost(parsed.data.id)
      return { ...parsed.data, generation: connection.generation }
    }
    // The summary's descriptors name results this generation holds; main stamps the generation on them.
    if (method === 'query.execute') {
      const parsed = queryResultSchema.safeParse(result)
      if (!parsed.success) throw new BackendError('BACKEND_ERROR', sentences.invalid)
      return { ...parsed.data, resultSets: parsed.data.resultSets.map(descriptor => stamp(descriptor, connection.generation)) }
    }
    if (method === 'debug.results.synthesize') return stamp(result as BackendResultDescriptor, connection.generation)
    if (method === 'connections.disconnect') { const id = idOf(params, 'connectionId'); if (id !== undefined) this.live.delete(id) }
    if (method === 'query.session.close') { const id = idOf(params, 'sessionId'); if (id !== undefined) this.sessions.delete(id) }
    return result
  }

  private unavailable(): BackendError {
    if (this.closing) return new BackendError('BACKEND_UNAVAILABLE', sentences.closing)
    const state = this.snapshot
    return new BackendError('BACKEND_UNAVAILABLE', state.status === 'failed' && state.reason !== 'crashLoop' ? state.message : sentences.unavailable)
  }

  private launch(): void {
    this.clock.clearTimeout(this.restartTimer)
    const generation = ++this.generation
    // Without the development build `dotnet` still starts, prints its error on stdout and exits: a "crash" three times
    // over, where the user needs the setup sentence. Checked at every launch, so Restart works once it is built.
    const requires = this.spec.requires
    if (requires !== undefined && !existsSync(requires)) {
      const loss: Loss = { reason: 'spawn', detail: `ENOENT (${basename(requires)})` }
      this.retired = { generation, reason: loss.reason, loss, uptimeMs: 0 }
      return this.fail('spawn', failureMessage(loss, this.spec.packaged)!)
    }
    const connection = new BackendConnection(this.spec, generation, this.deps)
    this.connection = connection
    this.readySince = undefined
    this.setState({ status: 'starting', generation })
    connection.ready.then(() => {
      if (this.connection !== connection || connection.lost) return
      this.readySince = this.clock.now()
      this.setState(this.readyState(connection))
      this.startWatchdog()
    }, () => {})
    connection.onLoss(loss => this.onLoss(connection, loss))
    for (const waiter of this.waiting.splice(0)) waiter.resolve(connection)
  }

  private onLoss(connection: BackendConnection, loss: Loss): void {
    // A generation main replaced itself (restart, stop) was reported there.
    if (this.connection !== connection) return
    this.connection = undefined
    this.stopWatchdog()
    const failure = failureMessage(loss, this.spec.packaged)
    if (failure) {
      // It failed before HELLO, so it held no connections and ran nothing; retrying would fail the same way.
      this.remember(connection, loss.reason, loss)
      return this.fail(loss.reason === 'spawn' ? 'spawn' : 'incompatible', failure)
    }
    const now = this.clock.now()
    if (this.readySince !== undefined && now - this.readySince >= this.policy.resetAfterMs) { this.attempts = 0; this.losses = [] }
    const reason: LossReason = loss.reason === 'protocol' || loss.reason === 'helloTimeout' || loss.reason === 'crash' ? loss.reason : 'exit'
    const lost = this.retire(connection, reason, loss)
    this.losses = [...this.losses.filter(at => now - at < this.policy.breakerWindowMs), now]
    this.attempts++
    if (this.losses.length >= this.policy.breakerLosses) return this.fail('crashLoop', sentences.crashLoop, lost)
    const retryInMs = this.policy.delaysMs[Math.min(this.attempts, this.policy.delaysMs.length) - 1] ?? 0
    this.setState({ status: 'restarting', generation: connection.generation, lost, retryInMs })
    this.restartTimer = this.clock.setTimeout(() => {
      if (!this.closing && !this.connection && this.snapshot.status === 'restarting') this.launch()
    }, retryInMs)
  }

  /** Moves a generation's connections to the lost set and remembers how it ended, for Copy details. */
  private retire(connection: BackendConnection, reason: LossReason, loss?: Loss): LostSummary {
    let connections = 0
    for (const [id, generation] of this.live) {
      if (generation !== connection.generation) continue
      this.live.delete(id)
      this.markLost(id)
      connections++
    }
    this.remember(connection, reason, loss)
    return { generation: connection.generation, reason, connections, queries: loss?.queries ?? connection.runningQueries }
  }

  private remember(connection: BackendConnection, reason: string, loss: Loss | undefined): void {
    const retired: Retired = { generation: connection.generation, reason, loss, uptimeMs: this.clock.now() - connection.startedAt, hello: connection.info, connection }
    this.retired = retired
    // stderr is a separate pipe: a crash's diagnostic line can arrive after the GOAWAY that ended the generation, so
    // failed details are rebuilt once the process has closed and its stderr is complete.
    void connection.closed.then(() => {
      const state = this.snapshot
      if (this.retired !== retired || state.status !== 'failed') return
      const details = this.details(`failed (${state.reason})`)
      if (details !== state.details) this.setState({ ...state, details })
    })
  }

  private markLost(id: string): void {
    this.lost.add(id)
    if (this.lost.size > wire.registries.lostConnections) this.lost.delete(this.lost.values().next().value!)
  }

  private fail(reason: 'crashLoop' | 'spawn' | 'incompatible', message: string, lost?: LostSummary): void {
    this.setState({ status: 'failed', reason, message, ...(lost ? { lost } : {}), details: this.details(`failed (${reason})`) })
    const error = this.unavailable()
    for (const waiter of this.waiting.splice(0)) waiter.reject(error)
  }

  private readyState(connection: BackendConnection): BackendState {
    const hello = connection.info!
    return { status: 'ready', generation: connection.generation, pid: hello.pid, runtime: hello.runtime, platform: hello.platform }
  }

  /** Fixed-format facts for a bug report: no SQL, server names, or connection strings (stderr carries none either). */
  private details(status: string): string {
    const retired = this.retired, now = this.clock.now()
    const loss = retired?.loss
    return [
      `Status: ${status}`,
      `Generation: ${this.generation}`,
      retired ? `Last loss: generation ${retired.generation}, ${retired.reason}${loss ? ` (${loss.detail})` : ''}` : 'Last loss: none',
      `Exit code: ${loss?.exitCode ?? 'none'}; signal: ${loss?.signal ?? 'none'}`,
      `Uptime: ${retired ? (retired.uptimeMs / 1000).toFixed(1) + ' s' : 'unknown'}`,
      `Losses in the last ${Math.round(this.policy.breakerWindowMs / 1000)} s: ${this.losses.filter(at => now - at < this.policy.breakerWindowMs).length}`,
      `Protocol: ${PROTOCOL_VERSION}`,
      `Runtime: ${retired?.hello?.runtime ?? 'unknown'}`,
      `OS: ${retired?.hello?.platform ?? `${process.platform} ${process.arch}`}`,
      'Backend diagnostics (stderr):',
      ...(retired?.connection?.stderr.length ? retired.connection.stderr.map(line => '  ' + line) : ['  none'])
    ].join('\n')
  }

  private setState(state: BackendState): void {
    this.snapshot = state
    for (const listener of [...this.listeners]) {
      try { listener(state) } catch { /* A listener's failure must not stop the others or the supervisor. */ }
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog()
    this.windowStart = this.clock.now()
    this.scheduleTick()
  }

  private stopWatchdog(): void { this.clock.clearTimeout(this.watchdogTimer) }

  private scheduleTick(): void {
    this.expectedTick = this.clock.now() + this.tickMs
    this.watchdogTimer = this.clock.setTimeout(() => this.tick(), this.tickMs)
  }

  private tick(): void {
    const connection = this.connection
    if (!connection?.isReady) return
    const now = this.clock.now()
    // A late tick means main itself stalled (a synchronous dialog, a long GC): frames may be waiting in the pipe, so
    // the silence window starts again rather than counting time main could not read.
    if (this.suspended || now - this.expectedTick > 2 * this.tickMs) this.windowStart = now
    this.scheduleTick()
    if (this.suspended) return
    const silentMs = () => Math.min(connection.silentMs, this.clock.now() - this.windowStart)
    // Only a frame ends the warning: a fresh window (resume, a late tick) shows main was away, not that the backend spoke.
    if (this.snapshot.status === 'unresponsive') {
      if (connection.silentMs < this.unresponsiveMs) this.setState(this.readyState(connection))
      return
    }
    if (this.snapshot.status !== 'ready' || silentMs() < this.unresponsiveMs) return
    // Timers run before I/O is polled, so a PONG already in the pipe gets one turn to arrive.
    this.yieldTurn(() => {
      if (this.connection !== connection || this.snapshot.status !== 'ready' || this.suspended) return
      const silent = silentMs()
      if (silent >= this.unresponsiveMs) this.setState({ status: 'unresponsive', generation: connection.generation, silentMs: Math.round(silent) })
    })
  }
}
