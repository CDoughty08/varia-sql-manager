import type { DatabaseInfo, VariaApi } from '../../../shared/contracts'
import { onUnexpectedError } from '../core/errors'
import type { EventBus } from '../core/events'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import type { LiveConnection } from './connections'

export type DatabaseLists = ReadonlyMap<string, readonly DatabaseInfo[]>
const none: readonly DatabaseInfo[] = []

/**
 * The databases each connected server lets the login open (`databases.list`), for the toolbar's database picker. A list
 * loads when its connection is added and again when Object Explorer refreshes the server or a databases folder; a
 * failed load keeps the previous list, and lost or removed connections drop theirs.
 */
export class DatabaseListService extends SnapshotStore<DatabaseLists> implements Disposable {
  /** Connections with a load in flight; true when another load was asked for meanwhile. */
  private readonly loading = new Map<string, boolean>()
  private readonly subscriptions: (() => void)[]
  private disposed = false

  constructor(private readonly api: Pick<VariaApi, 'databases'>, private readonly connections: ExternalStore<readonly LiveConnection[]>, events: Pick<EventBus, 'subscribe'>) {
    super(new Map())
    const subscription = events.subscribe(event => {
      if (event.type === 'explorer.refreshed' && event.scope !== 'other') void this.reload(event.connectionId)
    })
    this.subscriptions = [connections.subscribe(() => this.sync()), () => subscription.dispose()]
    this.sync()
  }

  get(connectionId: string): readonly DatabaseInfo[] { return this.getSnapshot().get(connectionId) ?? none }

  /** Loads a connection's list. One load runs at a time per connection; asking again meanwhile loads once more after it. */
  async reload(connectionId: string): Promise<void> {
    if (!this.live(connectionId)) return
    if (this.loading.has(connectionId)) { this.loading.set(connectionId, true); return }
    this.loading.set(connectionId, false)
    try {
      for (;;) {
        let result
        try { result = await this.api.databases(connectionId) } catch (error) { onUnexpectedError(error); result = undefined }
        if (this.disposed || !this.live(connectionId)) return
        if (result?.ok) this.set(connectionId, result.value)
        if (!this.loading.get(connectionId)) return
        this.loading.set(connectionId, false)
      }
    } finally { this.loading.delete(connectionId) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.subscriptions.forEach(unsubscribe => unsubscribe())
    this.clearListeners()
  }

  private live(connectionId: string): boolean { return !this.disposed && this.connections.getSnapshot().some(connection => connection.id === connectionId && !connection.lost) }

  private sync(): void {
    if (this.disposed) return
    const live = new Set(this.connections.getSnapshot().filter(connection => !connection.lost).map(connection => connection.id))
    const lists = this.getSnapshot()
    const dropped = [...lists.keys()].filter(id => !live.has(id))
    if (dropped.length) { const next = new Map(lists); dropped.forEach(id => next.delete(id)); this.publish(next) }
    for (const id of live) if (!lists.has(id) && !this.loading.has(id)) void this.reload(id)
  }

  private set(connectionId: string, databases: readonly DatabaseInfo[]): void {
    const next = new Map(this.getSnapshot())
    next.set(connectionId, databases)
    this.publish(next)
  }
}
