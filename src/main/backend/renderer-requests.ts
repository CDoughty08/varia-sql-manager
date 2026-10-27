import { cancelReasons, type CancelReason } from '../../shared/ipc/wire/protocol'
import { BackendError } from './errors'

export interface CancelTarget { cancel(generation: number, id: number, reason: CancelReason): void }
interface Request { frame?: { readonly generation: number; readonly id: number }; cancelled: boolean }

export interface RendererRequestLimits {
  /** Ids cancelled before main saw them, kept so the request is refused if it arrives late. */
  readonly tombstones: number
  readonly tombstoneMs: number
  readonly running: number
  /** Ids one cancel call may name. */
  readonly cancelBatch: number
}

/**
 * Cancellation in main for backend requests the renderer names by `requestId` (Object Explorer loads, scripting): each
 * id maps to the REQUEST frame it went out as, so a cancel becomes a protocol v2 CANCEL frame (reason 1). A cancel for a
 * request not yet written (waiting for a restarting backend) is sent as soon as it is; one for an id main has not seen
 * is kept as a tombstone for a while, so that request is refused if it arrives late. There is no backend method for it.
 */
export class RendererRequests {
  readonly limits: RendererRequestLimits
  private readonly requests = new Map<string, Request>()
  private readonly tombstones = new Map<string, number>()
  private readonly backend: CancelTarget
  private readonly noun: string
  private readonly now: () => number

  constructor(backend: CancelTarget, limits: RendererRequestLimits, noun: string, now: () => number = Date.now) {
    this.backend = backend
    this.limits = limits
    this.noun = noun
    this.now = now
  }

  get running(): number { return this.requests.size }

  /** Registers a request before it is sent. Throws CANCELLED for a tombstoned id and DUPLICATE_REQUEST for one already running. */
  begin(requestId: string): { sent: (id: number, generation: number) => void; end: () => void } {
    this.prune()
    if (this.tombstones.delete(requestId)) throw new BackendError('CANCELLED', 'The operation was cancelled.')
    if (this.requests.has(requestId)) throw new BackendError('DUPLICATE_REQUEST', `This ${this.noun} request is already running.`)
    if (this.requests.size >= this.limits.running) throw new BackendError('TOO_MANY_REQUESTS', 'Too many pending backend requests.')
    const request: Request = { cancelled: false }
    this.requests.set(requestId, request)
    return {
      sent: (id, generation) => {
        request.frame = { generation, id }
        if (request.cancelled) this.backend.cancel(generation, id, cancelReasons.user)
      },
      end: () => { if (this.requests.get(requestId) === request) this.requests.delete(requestId) }
    }
  }

  /** Cancels requests by id (at most `limits.cancelBatch`); returns how many were running. */
  cancel(requestIds: readonly string[]): number {
    this.prune()
    let cancelled = 0
    for (const requestId of requestIds.slice(0, this.limits.cancelBatch)) {
      const request = this.requests.get(requestId)
      if (!request) { this.tombstone(requestId); continue }
      if (request.cancelled) continue
      request.cancelled = true
      cancelled++
      if (request.frame) this.backend.cancel(request.frame.generation, request.frame.id, cancelReasons.user)
    }
    return cancelled
  }

  private tombstone(requestId: string): void {
    this.tombstones.delete(requestId)
    this.tombstones.set(requestId, this.now())
    if (this.tombstones.size > this.limits.tombstones) this.tombstones.delete(this.tombstones.keys().next().value!)
  }

  private prune(): void {
    const cutoff = this.now() - this.limits.tombstoneMs
    for (const [id, at] of this.tombstones) {
      if (at > cutoff) break
      this.tombstones.delete(id)
    }
  }
}

/** The methods main registers before sending, so their cancel channel (varia:explorer-cancel, varia:scripting-cancel,
 *  varia:actions-cancel, varia:activity-cancel, varia:connections-cancel) can always find them; any other method is not
 *  cancellable by `requestId`. A connect or Load databases is, only when the dialog gave it one (`connectRequestId`, from
 *  its context). Of the Activity Monitor's methods only Details is: Kill carries no requestId. */
export function cancellableRequests<T>(method: string, channels: { readonly explorer: T; readonly scripting: T; readonly actions: T; readonly activity: T; readonly connections: T }, connectRequestId?: string): T | undefined {
  if (method === 'connections.connect' || method === 'connections.databases') return connectRequestId ? channels.connections : undefined
  return method === 'explorer.children' ? channels.explorer : method === 'scripting.script' ? channels.scripting : method.startsWith('actions.') ? channels.actions
    : method === 'activity.details' ? channels.activity : undefined
}

/** The Connect dialog's requests: few run at once (one connect and one Load databases per dialog). */
export const connectionRequestLimits = { tombstones: 64, tombstoneMs: 60_000, running: 8, cancelBatch: 16 } as const
