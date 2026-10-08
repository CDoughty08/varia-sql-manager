import type { ConnectionInfo } from '../../../shared/contracts'
import { SnapshotStore } from '../core/store'

// Live connection metadata only; existing UI and IPC still own connect/disconnect.
export class ConnectionService extends SnapshotStore<readonly ConnectionInfo[]> {
  constructor() { super([]) }
  get(id: string): ConnectionInfo | undefined { return this.getSnapshot().find(connection => connection.id === id) }
  add(connection: ConnectionInfo): void { this.publish([...this.getSnapshot(), connection]) }
  remove(id: string): void { this.publish(this.getSnapshot().filter(connection => connection.id !== id)) }
  dispose(): void { this.clearListeners(); this.publish([]) }
}
