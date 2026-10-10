import { cancelReasons, type CancelReason } from '../../shared/ipc/wire/protocol'
import { explorerLimits } from '../../shared/explorer/catalog.ts'
import { BackendError } from './errors'

export interface CancelTarget { cancel(generation: number, id: number, reason: CancelReason): void }
interface Load { frame?: { readonly generation: number; readonly id: number }; cancelled: boolean }

export const explorerRequestLimits = { tombstones: 1024, tombstoneMs: 60_000, running: 1024 } as const

/**
 * Object Explorer cancellation in main: the renderer names its loads by `requestId`, and this maps each one to the
 * REQUEST frame it went out as, so a cancel becomes a protocol v2 CANCEL frame (reason 1). A cancel for a load not yet
 * written (waiting for a restarting backend) is sent as soon as it is; one for an id main has not seen is kept as a
 * tombstone for 60 s, so that load is refused if it arrives late. There is no backend method for it.
 */
export class ExplorerRequests {
  private readonly loads = new Map<string, Load>()
  private readonly tombstones = new Map<string, number>()
  private readonly backend: CancelTarget
  private readonly now: () => number

  constructor(backend: CancelTarget, now: () => number = Date.now) {
    this.backend = backend
    this.now = now
  }

  get running(): number { return this.loads.size }

  /** Registers a load before it is sent. Throws CANCELLED for a tombstoned id and DUPLICATE_REQUEST for one already running. */
  begin(requestId: string): { sent: (id: number, generation: number) => void; end: () => void } {
    this.prune()
    if (this.tombstones.delete(requestId)) throw new BackendError('CANCELLED', 'The operation was cancelled.')
    if (this.loads.has(requestId)) throw new BackendError('DUPLICATE_REQUEST', 'This Object Explorer request is already running.')
    if (this.loads.size >= explorerRequestLimits.running) throw new BackendError('TOO_MANY_REQUESTS', 'Too many pending backend requests.')
    const load: Load = { cancelled: false }
    this.loads.set(requestId, load)
    return {
      sent: (id, generation) => {
        load.frame = { generation, id }
        if (load.cancelled) this.backend.cancel(generation, id, cancelReasons.user)
      },
      end: () => { if (this.loads.get(requestId) === load) this.loads.delete(requestId) }
    }
  }

  /** Cancels loads by id (at most `explorerLimits.cancelBatch`); returns how many were running. */
  cancel(requestIds: readonly string[]): number {
    this.prune()
    let cancelled = 0
    for (const requestId of requestIds.slice(0, explorerLimits.cancelBatch)) {
      const load = this.loads.get(requestId)
      if (!load) { this.tombstone(requestId); continue }
      if (load.cancelled) continue
      load.cancelled = true
      cancelled++
      if (load.frame) this.backend.cancel(load.frame.generation, load.frame.id, cancelReasons.user)
    }
    return cancelled
  }

  private tombstone(requestId: string): void {
    this.tombstones.delete(requestId)
    this.tombstones.set(requestId, this.now())
    if (this.tombstones.size > explorerRequestLimits.tombstones) this.tombstones.delete(this.tombstones.keys().next().value!)
  }

  private prune(): void {
    const cutoff = this.now() - explorerRequestLimits.tombstoneMs
    for (const [id, at] of this.tombstones) {
      if (at > cutoff) break
      this.tombstones.delete(id)
    }
  }
}
