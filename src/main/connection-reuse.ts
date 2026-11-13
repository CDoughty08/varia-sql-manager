import { z } from 'zod'
import { backendConnectionHandleSchema, connectionTargetLimits, expectedConnectionPrincipalSchema, type BackendConnectionHandle } from '../shared/connection-targets'
import { connectionOptionsSchema } from '../shared/connections'
import type { ConnectionOptions } from '../shared/contracts'
import { ConnectionIdentityRegistry, type ConnectionIdentityKey, type ConnectionPrincipalEvidence } from './connection-identity'

export interface ConnectionReuseRequest {
  readonly targetId: string
  /** Main stamps this from the backend owner, never from the renderer. */
  readonly generation: number
  /** Validated options after main has resolved the exact remembered credential revision. */
  readonly options: ConnectionOptions
  /** Optional account resolved by trusted authentication infrastructure before opening SQL. */
  readonly principal?: ConnectionPrincipalEvidence
  readonly expectedPrincipal?: ConnectionPrincipalEvidence
  readonly credentialIntent?: 'preserve' | 'update-credentials'
  /** Cancels this caller's interest, without disposing a handle another caller accepted. */
  readonly signal?: AbortSignal
}

export interface AuthenticatedConnection<T extends BackendConnectionHandle> {
  readonly connection: T
  /** Trusted backend/provider evidence, never the requested username or a rotating token. */
  readonly principal: ConnectionPrincipalEvidence
}

export type ConnectionReuseOutcome<T extends BackendConnectionHandle> =
  | { readonly status: 'connected' | 'reused'; readonly targetId: string; readonly connection: T; readonly principal: ConnectionPrincipalEvidence }
  | { readonly status: 'cancelled' | 'identity-changed' | 'invalid' | 'busy' }
  | { readonly status: 'failed'; readonly error: unknown }

export interface ConnectionReuseDeps<T extends BackendConnectionHandle> {
  /** Called only by the operation owner, for a newly opened handle no target accepted. */
  readonly dispose: (connection: T) => Promise<void>
  /** Cleanup failures must go to main's existing failure handling, without logging connection data. */
  readonly cleanupFailed?: (error: unknown) => void
}

interface Live<T extends BackendConnectionHandle> extends AuthenticatedConnection<T> {
  readonly targetId: string
  readonly key: ConnectionIdentityKey
  disconnecting: boolean
}
interface Waiter<T extends BackendConnectionHandle> {
  readonly targetId: string
  readonly finish: (outcome: ConnectionReuseOutcome<T>) => void
}
interface Pending<T extends BackendConnectionHandle> {
  readonly request: ConnectionReuseRequest
  readonly joinKey?: string
  readonly controller: AbortController
  readonly waiters: Set<Waiter<T>>
  cancelled: boolean
}

const targetIdSchema = z.uuid()
const samePrincipal = (left: ConnectionPrincipalEvidence, right: ConnectionPrincipalEvidence) => left.authentication === right.authentication && left.id === right.id
const validPrincipal = (principal: ConnectionPrincipalEvidence) => expectedConnectionPrincipalSchema.safeParse({ provider: 'sqlServer', ...principal }).success
const handleKey = (handle: BackendConnectionHandle) => `${handle.generation}:${handle.id}`

/**
 * Main's sole owner of live Explorer transports and their pending opens. This class never serializes keys or keeps
 * passwords after an open settles. Query SQL sessions remain owned by their existing query/session services.
 * Construction and every method call belong to the trusted main connection flow, not a generic IPC endpoint.
 */
export class ConnectionReuseCoordinator<T extends BackendConnectionHandle> {
  readonly #deps: ConnectionReuseDeps<T>
  readonly #identity = new ConnectionIdentityRegistry()
  readonly #live = new Map<string, Live<T>>()
  readonly #pending = new Set<Pending<T>>()
  readonly #joins = new Map<string, Pending<T>>()
  /** Ephemeral credential-sensitive affinity, never a transport owner or a persisted password verifier. */
  readonly #offline = new Map<ConnectionIdentityKey, { targetId: string; principal: ConnectionPrincipalEvidence }>()
  #generation = 0
  #disposed = false

  constructor(deps: ConnectionReuseDeps<T>) { this.#deps = deps }

  connect(request: ConnectionReuseRequest, open: (signal: AbortSignal) => Promise<AuthenticatedConnection<T>>): Promise<ConnectionReuseOutcome<T>> {
    const parsed = connectionOptionsSchema.safeParse(request.options)
    if (!targetIdSchema.safeParse(request.targetId).success || !parsed.success || !Number.isSafeInteger(request.generation) || request.generation < 0
      || (request.principal && !validPrincipal(request.principal)) || (request.expectedPrincipal && !validPrincipal(request.expectedPrincipal))
      || (request.credentialIntent !== undefined && request.credentialIntent !== 'preserve' && request.credentialIntent !== 'update-credentials')) return Promise.resolve({ status: 'invalid' })
    if (this.#disposed || request.generation < this.#generation || request.signal?.aborted) return Promise.resolve({ status: 'cancelled' })
    this.markLostBefore(request.generation)
    // Copy validated inputs before asynchronous authentication, including evidence, so a caller cannot mutate a join.
    const candidate: ConnectionReuseRequest = { ...request, options: parsed.data,
      ...(request.principal ? { principal: { ...request.principal } } : {}),
      ...(request.expectedPrincipal ? { expectedPrincipal: { ...request.expectedPrincipal } } : {}) }
    const key = this.#key(candidate.options, candidate.principal)
    if (key && [...this.#live.values()].some(value => value.key === key && value.disconnecting)) return Promise.resolve({ status: 'busy' })
    const live = key ? this.#matchingLive(key) : undefined
    if (live) {
      if ((candidate.expectedPrincipal && !samePrincipal(candidate.expectedPrincipal, live.principal))
        || (candidate.principal && !samePrincipal(candidate.principal, live.principal))) return Promise.resolve({ status: 'identity-changed' })
      return Promise.resolve(this.#outcome(live, 'reused'))
    }
    // A target already being disconnected cannot acquire a replacement transport during its close preflight/mutation.
    if ([...this.#live.values()].some(value => value.targetId === candidate.targetId)) return Promise.resolve({ status: 'busy' })
    const joinKey = key ? JSON.stringify([key, candidate.credentialIntent ?? 'preserve', candidate.expectedPrincipal ?? null]) : undefined
    const joined = joinKey ? this.#joins.get(joinKey) : undefined
    if (joined) return joined.waiters.size < connectionTargetLimits.targets ? this.#wait(joined, candidate) : Promise.resolve({ status: 'busy' })
    if (this.#pending.size >= connectionTargetLimits.targets || this.#live.size >= connectionTargetLimits.targets) return Promise.resolve({ status: 'busy' })
    const pending: Pending<T> = { request: candidate, joinKey, controller: new AbortController(), waiters: new Set(), cancelled: false }
    this.#pending.add(pending)
    if (joinKey) this.#joins.set(joinKey, pending)
    const result = this.#wait(pending, candidate)
    // The single operation owns completion, acceptance and cleanup. Joined callers only receive its immutable answer.
    void this.#open(pending, open)
    return result
  }

  /** Explicit Stop/removal of the operation's target invalidates every join. A joined caller cancels only itself. */
  cancelTarget(targetId: string): void {
    for (const pending of this.#pending) {
      if (pending.request.targetId === targetId) this.#cancel(pending)
      else for (const waiter of [...pending.waiters]) if (waiter.targetId === targetId) waiter.finish({ status: 'cancelled' })
      if (!pending.waiters.size) this.#cancel(pending)
    }
  }

  /** Fence the live handle after the whole disconnect preflight and before sending its disconnect request. */
  beginDisconnect(connection: BackendConnectionHandle): boolean {
    const live = this.#live.get(handleKey(connection))
    if (!live || live.disconnecting) return false
    live.disconnecting = true
    this.cancelTarget(live.targetId)
    return true
  }

  /** Failure keeps the accepted handle reusable; success forgets it only after the backend acknowledged closing it. */
  finishDisconnect(connection: BackendConnectionHandle, succeeded: boolean): boolean {
    const key = handleKey(connection), live = this.#live.get(key)
    if (!live?.disconnecting) return false
    if (succeeded) {
      this.#live.delete(key)
      this.#offline.set(live.key, { targetId: live.targetId, principal: live.principal })
      if (this.#offline.size > connectionTargetLimits.targets) this.#offline.delete(this.#offline.keys().next().value!)
    }
    else live.disconnecting = false
    return true
  }

  /** Removal of an offline target. A live target must complete its disconnect first. */
  removeTarget(targetId: string): boolean {
    this.cancelTarget(targetId)
    if ([...this.#live.values()].some(value => value.targetId === targetId)) return false
    for (const [key, affinity] of this.#offline) if (affinity.targetId === targetId) this.#offline.delete(key)
    return true
  }

  hasTarget(targetId: string): boolean {
    return [...this.#live.values()].some(value => value.targetId === targetId) || [...this.#pending].some(value => !value.cancelled && (value.request.targetId === targetId || [...value.waiters].some(waiter => waiter.targetId === targetId)))
  }

  markLostBefore(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation <= this.#generation) return
    this.#generation = generation
    this.#offline.clear()
    for (const pending of this.#pending) if (pending.request.generation < generation) this.#cancel(pending)
    for (const [key, live] of this.#live) if (live.connection.generation < generation) this.#live.delete(key)
  }

  /** Backend shutdown owns live transport disposal. Late pending successes are still cleaned up by their owner. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const pending of this.#pending) this.#cancel(pending)
    this.#live.clear()
    this.#offline.clear()
    this.#identity.dispose()
  }

  #key(options: ConnectionOptions, principal?: ConnectionPrincipalEvidence): ConnectionIdentityKey | undefined {
    // SQL login + actual supplied password can be compared before opening; the trusted resolved principal is checked
    // separately. Dynamic authentication requires trusted account evidence, even when a username was entered.
    return this.#identity.key(options, options.authentication === 'sql' ? undefined : principal)
  }

  #matchingLive(key: ConnectionIdentityKey): Live<T> | undefined {
    return [...this.#live.values()].find(value => value.key === key && !value.disconnecting && value.connection.generation === this.#generation)
  }

  #outcome(live: Live<T>, status: 'connected' | 'reused'): ConnectionReuseOutcome<T> {
    return Object.freeze({ status, targetId: live.targetId, connection: live.connection, principal: live.principal })
  }

  #wait(pending: Pending<T>, request: ConnectionReuseRequest): Promise<ConnectionReuseOutcome<T>> {
    return new Promise(resolve => {
      const abort = () => {
        waiter.finish({ status: 'cancelled' })
        if (!pending.waiters.size) this.#cancel(pending)
      }
      const waiter: Waiter<T> = { targetId: request.targetId, finish: outcome => {
        if (!pending.waiters.delete(waiter)) return
        request.signal?.removeEventListener('abort', abort)
        resolve(outcome)
      } }
      pending.waiters.add(waiter)
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) abort()
    })
  }

  #cancel(pending: Pending<T>): void {
    if (pending.cancelled) return
    pending.cancelled = true
    this.#unjoin(pending)
    pending.controller.abort()
    for (const waiter of [...pending.waiters]) waiter.finish({ status: 'cancelled' })
  }

  #unjoin(pending: Pending<T>): void {
    if (pending.joinKey && this.#joins.get(pending.joinKey) === pending) this.#joins.delete(pending.joinKey)
  }

  async #cleanup(connection: T): Promise<void> {
    // The backend may return the already accepted handle. It belongs to that target, even to a stale/cancelled caller.
    if (this.#live.has(handleKey(connection))) return
    try { await this.#deps.dispose(connection) } catch (error) { this.#deps.cleanupFailed?.(error) }
  }

  async #open(pending: Pending<T>, open: (signal: AbortSignal) => Promise<AuthenticatedConnection<T>>): Promise<void> {
    let outcome: ConnectionReuseOutcome<T>
    try {
      const answer = await open(pending.controller.signal), request = pending.request
      if (pending.cancelled || this.#disposed || request.generation !== this.#generation || answer.connection.generation !== request.generation) {
        await this.#cleanup(answer.connection)
        outcome = { status: 'cancelled' }
      } else if (!backendConnectionHandleSchema.safeParse({ id: answer.connection.id, generation: answer.connection.generation }).success
        || !validPrincipal(answer.principal) || answer.principal.authentication !== request.options.authentication) {
        await this.#cleanup(answer.connection)
        outcome = { status: 'invalid' }
      } else if ((request.expectedPrincipal && !samePrincipal(request.expectedPrincipal, answer.principal))
        || (request.principal && !samePrincipal(request.principal, answer.principal))) {
        await this.#cleanup(answer.connection)
        outcome = { status: 'identity-changed' }
      } else {
        const key = this.#key(request.options, answer.principal), equivalent = key ? this.#matchingLive(key) : undefined
        const occupied = this.#live.get(handleKey(answer.connection))
        if (equivalent) {
          await this.#cleanup(answer.connection)
          // Cleanup crosses an await: a disconnect or generation change may have taken that handle in the meantime.
          outcome = !pending.cancelled && !this.#disposed && this.#live.get(handleKey(equivalent.connection)) === equivalent
            && !equivalent.disconnecting && request.generation === this.#generation ? this.#outcome(equivalent, 'reused') : { status: 'cancelled' }
        } else if (!key || occupied || [...this.#live.values()].some(value => value.targetId === request.targetId || value.key === key && value.disconnecting)) {
          await this.#cleanup(answer.connection)
          outcome = { status: key ? 'busy' : 'identity-changed' }
        } else if (this.#live.size >= connectionTargetLimits.targets) {
          await this.#cleanup(answer.connection)
          outcome = { status: 'busy' }
        } else {
          const affinity = this.#offline.get(key)
          const targetId = affinity && samePrincipal(affinity.principal, answer.principal) && ![...this.#live.values()].some(value => value.targetId === affinity.targetId) ? affinity.targetId : request.targetId
          const live: Live<T> = { targetId, key, connection: Object.freeze({ ...answer.connection }), principal: Object.freeze({ ...answer.principal }), disconnecting: false }
          // Only the latest binding of a target can supply offline affinity. An old credential must not attach a
          // second handle to that target after an explicit credential update opened a different live key.
          for (const [offlineKey, value] of this.#offline) if (offlineKey === key || value.targetId === targetId) this.#offline.delete(offlineKey)
          this.#live.set(handleKey(live.connection), live)
          outcome = this.#outcome(live, 'connected')
        }
      }
    } catch (error) { outcome = pending.cancelled || this.#disposed ? { status: 'cancelled' } : { status: 'failed', error } }
    this.#pending.delete(pending)
    this.#unjoin(pending)
    for (const waiter of [...pending.waiters]) waiter.finish(outcome)
  }
}
