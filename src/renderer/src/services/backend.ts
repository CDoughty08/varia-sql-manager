import type { BackendState, VariaApi } from '../../../shared/contracts'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'
import type { ConnectionService } from './connections'

/** Losses the user has not dismissed yet, added up. `unexpected` when any of them was not a manual restart. */
export interface BackendNotice { readonly unexpected: boolean; readonly connections: number; readonly queries: number }
export interface BackendSnapshot { readonly state: BackendState; readonly notice?: BackendNotice }
type BackendApi = Pick<VariaApi, 'getBackendState' | 'onBackendState' | 'restartBackend'>

/** The oldest generation whose connections still work in `state`; `restarting` names the generation that ended. */
export function liveGeneration(state: BackendState): number {
  switch (state.status) {
    case 'starting': case 'ready': case 'unresponsive': return state.generation
    case 'restarting': return state.generation + 1
    case 'failed': return state.lost ? state.lost.generation + 1 : 0
    case 'stopped': return 0
  }
}

/** The backend's state as main reports it, which also decides which connections are lost. */
export class BackendStateService extends SnapshotStore<BackendSnapshot> implements Disposable {
  private disposed = false
  /** The newest generation whose loss has been counted, so a state seen twice is counted once. */
  private counted = 0
  private readonly unsubscribe: () => void
  constructor(private readonly api: BackendApi, private readonly connections: Pick<ConnectionService, 'markLostBefore'>) {
    super({ state: { status: 'starting', generation: 0 } })
    // Main pushes every state after answering the request below, so applying both in arrival order keeps the latest.
    this.unsubscribe = api.onBackendState(state => this.receive(state))
    void api.getBackendState().then(result => { if (result.ok) this.receive(result.value) }, () => {})
  }
  receive(state: BackendState): void {
    if (this.disposed) return
    const lost = state.status === 'restarting' || state.status === 'failed' ? state.lost : undefined
    let notice = this.getSnapshot().notice
    if (lost && lost.generation > this.counted) {
      this.counted = lost.generation
      // A reload replaced the page that owned those connections, and a manual restart that closed nothing needs no note.
      if (lost.reason !== 'reload' && (lost.reason !== 'manual' || lost.connections > 0 || lost.queries > 0)) {
        notice = { unexpected: !!notice?.unexpected || lost.reason !== 'manual', connections: (notice?.connections ?? 0) + lost.connections, queries: (notice?.queries ?? 0) + lost.queries }
      }
    }
    this.connections.markLostBefore(liveGeneration(state))
    this.publish({ state, notice })
  }
  dismiss(): void { if (this.getSnapshot().notice) this.publish({ state: this.getSnapshot().state }) }
  /** Resolves to whether the backend restarted (the user can cancel main's confirmation). */
  async restart(): Promise<boolean> {
    const result = await this.api.restartBackend()
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  dispose(): void { this.disposed = true; this.unsubscribe(); this.clearListeners() }
}
