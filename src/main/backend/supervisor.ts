import type { RpcMethod, RpcMethods } from '../../shared/contracts'
import { deadlineFor } from '../../shared/ipc/methods'
import { BackendConnection, type BackendHello, type ConnectionDeps, type Loss, type SpawnSpec } from './connection'
import { BackendError, sentences } from './errors'

export type SupervisorStatus = 'stopped' | 'starting' | 'ready' | 'failed'

/**
 * Owns the backend process across generations. A request is bound to the generation that is current when it is made
 * and is written to that generation only: nothing is ever re-sent to a later one. In this version a loss is sticky
 * (the backend stays failed) until a workbench reload restarts it; automatic restarts come with the full supervisor.
 */
export class BackendSupervisor {
  private connection: BackendConnection | undefined
  private generation = 0
  private failure: BackendError | undefined
  private stopped = false
  private hello: BackendHello | undefined
  private readonly spec: SpawnSpec
  private readonly deps: ConnectionDeps

  constructor(spec: SpawnSpec, deps: ConnectionDeps = {}) {
    this.spec = spec
    this.deps = deps
  }

  get status(): SupervisorStatus {
    if (this.stopped || (!this.connection && !this.failure)) return 'stopped'
    if (this.failure) return 'failed'
    return this.connection?.isReady ? 'ready' : 'starting'
  }

  /** The current generation's connection, for tests and diagnostics. */
  get current(): BackendConnection | undefined { return this.connection }
  get lastHello(): BackendHello | undefined { return this.hello }

  start(): void {
    if (this.stopped || this.connection || this.failure) return
    this.launch()
  }

  async request<M extends RpcMethod>(method: M, params: RpcMethods[M]['params']): Promise<RpcMethods[M]['result']> {
    this.start()
    const connection = this.connection
    if (!connection) {
      // Nothing to disconnect or close on a backend that is not running: its connections and sessions are gone.
      if (method === 'connections.disconnect') return { disconnected: false } as RpcMethods[M]['result']
      if (method === 'query.session.close') return { closed: false } as RpcMethods[M]['result']
      throw this.failure ?? new BackendError('BACKEND_UNAVAILABLE', sentences.closing)
    }
    const { deadlineMs, backstopMs } = deadlineFor(method, params)
    return await connection.send(method, params, { deadlineMs, backstopMs }).done as RpcMethods[M]['result']
  }

  /** Ends the current generation (its sessions end with it) and starts the next one at once. A reload also recovers
   *  a failed backend. Requests still pending on the old generation fail; none is re-sent. */
  async restart(reason: 'reload'): Promise<void> {
    if (this.stopped) return
    const previous = this.connection
    this.connection = undefined
    this.failure = undefined
    this.launch()
    await previous?.close(undefined, new BackendError('BACKEND_LOST', reason === 'reload' ? sentences.reloaded : sentences.lost))
  }

  async stop(): Promise<void> {
    this.stopped = true
    const previous = this.connection
    this.connection = undefined
    this.failure = new BackendError('BACKEND_UNAVAILABLE', sentences.closing)
    await previous?.close()
  }

  private launch(): void {
    const connection = new BackendConnection(this.spec, ++this.generation, this.deps)
    this.connection = connection
    connection.ready.then(hello => { if (this.connection === connection) this.hello = hello }, () => {})
    connection.onLoss(loss => {
      if (this.connection !== connection) return
      this.connection = undefined
      this.failure = this.failureFor(loss)
    })
  }

  private failureFor(loss: Loss): BackendError {
    if (loss.reason === 'spawn') return new BackendError('BACKEND_UNAVAILABLE', this.spec.packaged ? sentences.spawnPackaged : sentences.spawnDevelopment)
    if (loss.reason === 'incompatible') return new BackendError('BACKEND_UNAVAILABLE', sentences.incompatible(loss.detail, this.spec.packaged))
    return new BackendError('BACKEND_UNAVAILABLE', sentences.stopped)
  }
}
