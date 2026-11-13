import { shouldAutoReconnect, type ConnectionTarget } from '../../../shared/connection-targets'
import type { Disposable } from '../core/types'
import type { ConnectionTargetService } from './connection-targets'

export interface StartupReconnectAttempt {
  readonly generation: number
  readonly signal: AbortSignal
  readonly mode: 'background'
  readonly credentialIntent: 'preserve'
}
/** Main refused another use of this saved binding; network/TLS/keyring failures do not suppress it. */
export interface StartupReconnectResult { readonly credentialRejected?: true }
export type StartupReconnect = (target: ConnectionTarget, attempt: StartupReconnectAttempt) => Promise<StartupReconnectResult>
type Registry = Pick<ConnectionTargetService, 'getSnapshot' | 'get' | 'subscribe'>
interface PendingAttempt { readonly target: ConnectionTarget; readonly controller: AbortController; readonly generation: number }
const credentialBinding = (target: ConnectionTarget): string | undefined => target.credential ? `${target.credential.profileId}:${target.credential.revision}` : undefined

/** Scheduling only: the ordinary connection owner retains operation tokens, authenticated completions and cleanup. */
export class StartupReconnectService implements Disposable {
  private generation = -1
  private queue: string[] = []
  private readonly active = new Map<string, PendingAttempt>()
  private readonly rejectedCredentials = new Set<string>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly unsubscribe: () => void
  private manual = 0
  private disposed = false

  constructor(private readonly targets: Registry, private readonly connect: StartupReconnect, private readonly globalDefault: () => boolean = () => true) {
    this.unsubscribe = targets.subscribe(() => this.refresh())
  }

  /** Restored targets must already be registered and presented as disconnected before starting the one pass. */
  start(generation: number): boolean {
    if (this.disposed || !Number.isSafeInteger(generation) || generation < 0 || generation <= this.generation) return false
    this.generation = generation
    this.abortActive()
    this.queue = this.targets.getSnapshot().filter(target => this.eligible(target)).map(target => target.id)
    this.refresh()
    return true
  }

  /** Call around each manual connect, including a picker that will request interactive sign-in. */
  beginManual(): Disposable {
    if (this.disposed) return { dispose() {} }
    this.manual++
    this.abortActive()
    let ended = false
    return { dispose: () => { if (!ended) { ended = true; this.manual--; this.refresh() } } }
  }

  /** The connection owner also invalidates its operation token when the user cancels or removes a target. */
  cancel(targetId: string): void {
    this.queue = this.queue.filter(id => id !== targetId)
    this.active.get(targetId)?.controller.abort()
    this.notifyIdle()
  }

  /** Registry changes call this automatically; call it after the global setting changes as well. */
  refresh(): void {
    if (this.disposed) return
    for (const [id, pending] of this.active) {
      const current = this.targets.get(id)
      if (!current || !this.wanted(current) || credentialBinding(current) !== credentialBinding(pending.target)) pending.controller.abort()
    }
    this.queue = this.queue.filter(id => { const target = this.targets.get(id); return !!target && this.eligible(target) })
    while (!this.manual && this.active.size < 2 && this.queue.length) {
      const next = this.queue.findIndex(id => !this.active.has(id))
      if (next < 0) break
      const target = this.targets.get(this.queue.splice(next, 1)[0])
      if (!target || !this.eligible(target)) continue
      const pending: PendingAttempt = { target, generation: this.generation, controller: new AbortController() }
      this.active.set(target.id, pending)
      void this.run(pending)
    }
    this.notifyIdle()
  }

  whenIdle(): Promise<void> {
    return !this.disposed && (this.queue.length || this.active.size) ? new Promise(resolve => this.idleWaiters.add(resolve)) : Promise.resolve()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.queue = []
    this.abortActive()
    // Disposal must not wait for a provider that is still observing cancellation.
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private wanted(target: ConnectionTarget): boolean { return shouldAutoReconnect(target, this.globalDefault()) }
  private eligible(target: ConnectionTarget): boolean {
    const binding = credentialBinding(target)
    return this.wanted(target) && (!binding || !this.rejectedCredentials.has(binding)) && ['disconnected', 'lost'].includes(target.lifecycle.state)
  }
  private abortActive(): void { for (const pending of this.active.values()) pending.controller.abort() }
  private async run(pending: PendingAttempt): Promise<void> {
    try {
      const result = await this.connect(pending.target, { generation: pending.generation, signal: pending.controller.signal, mode: 'background', credentialIntent: 'preserve' })
      const binding = credentialBinding(pending.target)
      if (result.credentialRejected && binding) {
        this.rejectedCredentials.add(binding)
        for (const other of this.active.values()) if (other !== pending && credentialBinding(other.target) === binding) other.controller.abort()
      }
    } catch {
      // The connection owner publishes the per-target failure. A thrown attempt must not stop unrelated targets.
    } finally {
      if (this.active.get(pending.target.id) === pending) this.active.delete(pending.target.id)
      this.refresh()
    }
  }
  private notifyIdle(): void {
    if (this.queue.length || this.active.size) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
