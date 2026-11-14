import { shouldAutoReconnect, type BackendConnectionHandle, type ConnectionTarget } from '../../../shared/connection-targets'
import type { Disposable } from '../core/types'
import type { ConnectionTargetService } from './connection-targets'

export interface StartupReconnectAttempt {
  readonly generation: number
  readonly signal: AbortSignal
  readonly mode: 'background'
  readonly credentialIntent: 'preserve'
  /** Adoption is synchronous after this boundary; foreground work must not interrupt its wanted-query attachment. */
  beginAcceptance(): boolean
  adopted(targetId: string, handle: BackendConnectionHandle): void
  /** The final coalescence and attachment are one synchronous mutation after all asynchronous checks. */
  finishAttachment(): boolean
}
/** Main refused another use of this saved binding; network/TLS/keyring failures do not suppress it. */
export interface StartupReconnectResult { readonly credentialRejected?: true; readonly interrupted?: true }
export type StartupReconnect = (target: ConnectionTarget, attempt: StartupReconnectAttempt) => Promise<StartupReconnectResult>
type Registry = Pick<ConnectionTargetService, 'getSnapshot' | 'get' | 'subscribe'>
interface PendingAttempt {
  readonly target: ConnectionTarget
  readonly controller: AbortController
  readonly generation: number
  preempted: boolean
  accepting: boolean
  adopted?: { readonly targetId: string; readonly handle: BackendConnectionHandle }
  finishing?: true
}
const credentialBinding = (target: ConnectionTarget): string | undefined => target.credential ? `${target.credential.profileId}:${target.credential.revision}` : undefined

/** Scheduling only: the ordinary connection owner retains operation tokens, authenticated completions and cleanup. */
export class StartupReconnectService implements Disposable {
  private generation = -1
  private queue: string[] = []
  private readonly active = new Map<string, PendingAttempt>()
  private readonly rejectedCredentials = new Set<string>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly activeWaiters = new Set<() => void>()
  private readonly unsubscribe: () => void
  private manual = 0
  private disposed = false

  constructor(private readonly targets: Registry, private readonly connect: StartupReconnect, private readonly globalDefault: () => boolean = () => true, private readonly canStart: () => boolean = () => true) {
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

  /** Pause admission for a manual connect or close checkpoint; interrupted targets retain their reconnect intent. */
  beginManual(): Disposable {
    if (this.disposed) return { dispose() {} }
    this.manual++
    for (const pending of this.active.values()) if (!pending.accepting && !pending.controller.signal.aborted) {
      pending.preempted = true
      pending.controller.abort()
    }
    let ended = false
    return { dispose: () => { if (!ended) { ended = true; this.manual--; this.refresh() } } }
  }

  /** The connection owner also invalidates its operation token when the user cancels or removes a target. */
  cancel(targetId: string): void {
    this.queue = this.queue.filter(id => id !== targetId)
    for (const pending of this.active.values()) if (pending.target.id === targetId || pending.adopted?.targetId === targetId) {
      pending.preempted = false
      pending.controller.abort()
    }
    this.notifyIdle()
  }

  /** Registry changes call this automatically; call it after the global setting changes as well. */
  refresh(): void {
    if (this.disposed) return
    for (const [id, pending] of this.active) {
      if (pending.finishing) continue
      if (pending.accepting) {
        // Adoption redirects/cancels the source synchronously. Observe its canonical owner only after that mutation.
        if (!pending.adopted) continue
        const { targetId, handle } = pending.adopted, canonical = this.targets.get(targetId), source = this.targets.get(id), state = canonical?.lifecycle
        if (!canonical?.inExplorer || !canonical.resumeWanted || state?.state !== 'connected' || state.handle.id !== handle.id || state.handle.generation !== handle.generation
          || targetId !== id && !source?.inExplorer) pending.controller.abort()
        continue
      }
      const current = this.targets.get(id)
      if (!current || !this.wanted(current) || credentialBinding(current) !== credentialBinding(pending.target)) pending.controller.abort()
    }
    this.queue = this.queue.filter(id => { const target = this.targets.get(id); return !!target && this.eligible(target) })
    while (!this.manual && this.canStart() && this.active.size < 2 && this.queue.length) {
      const next = this.queue.findIndex(id => !this.active.has(id))
      if (next < 0) break
      const target = this.targets.get(this.queue.splice(next, 1)[0])
      if (!target || !this.eligible(target)) continue
      const pending: PendingAttempt = { target, generation: this.generation, controller: new AbortController(), preempted: false, accepting: false }
      this.active.set(target.id, pending)
      void this.run(pending)
    }
    this.notifyIdle()
  }

  whenIdle(): Promise<void> {
    return !this.disposed && (this.queue.length || this.active.size) ? new Promise(resolve => this.idleWaiters.add(resolve)) : Promise.resolve()
  }

  /** Under beginManual, wait for admitted callbacks and their cancellation acknowledgements, ignoring paused targets. */
  whenActiveSettled(): Promise<void> {
    return !this.disposed && this.active.size ? new Promise(resolve => this.activeWaiters.add(resolve)) : Promise.resolve()
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
    for (const resolve of this.activeWaiters) resolve()
    this.activeWaiters.clear()
  }

  private wanted(target: ConnectionTarget): boolean { return shouldAutoReconnect(target, this.globalDefault()) }
  private eligible(target: ConnectionTarget): boolean {
    const binding = credentialBinding(target)
    return this.wanted(target) && (!binding || !this.rejectedCredentials.has(binding)) && ['disconnected', 'lost'].includes(target.lifecycle.state)
  }
  private abortActive(): void { for (const pending of this.active.values()) pending.controller.abort() }
  private async run(pending: PendingAttempt): Promise<void> {
    let interrupted = false
    try {
      const result = await this.connect(pending.target, {
        generation: pending.generation, signal: pending.controller.signal, mode: 'background', credentialIntent: 'preserve',
        beginAcceptance: () => {
          if (this.disposed || pending.controller.signal.aborted || pending.generation !== this.generation) return false
          pending.accepting = true
          return true
        },
        adopted: (targetId, handle) => {
          pending.adopted = { targetId, handle: { ...handle } }
          this.refresh()
        },
        finishAttachment: () => {
          if (this.disposed || pending.controller.signal.aborted || pending.generation !== this.generation) return false
          pending.finishing = true
          return true
        }
      })
      interrupted = result.interrupted === true
      const binding = credentialBinding(pending.target)
      if (result.credentialRejected && binding) {
        this.rejectedCredentials.add(binding)
        for (const other of this.active.values()) if (other !== pending && !other.accepting && credentialBinding(other.target) === binding) other.controller.abort()
      }
    } catch {
      // The connection owner publishes the per-target failure. A thrown attempt must not stop unrelated targets.
    } finally {
      if (this.active.get(pending.target.id) === pending) this.active.delete(pending.target.id)
      const current = this.targets.get(pending.target.id)
      if (!this.disposed && pending.preempted && interrupted && pending.generation === this.generation && current && this.eligible(current) && !this.queue.includes(current.id)) {
        this.queue.push(current.id)
        const order = new Map(this.targets.getSnapshot().map((target, index) => [target.id, index]))
        this.queue.sort((left, right) => order.get(left)! - order.get(right)!)
      }
      this.refresh()
    }
  }
  private notifyIdle(): void {
    if (!this.active.size) {
      for (const resolve of this.activeWaiters) resolve()
      this.activeWaiters.clear()
    }
    if (this.queue.length || this.active.size) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
