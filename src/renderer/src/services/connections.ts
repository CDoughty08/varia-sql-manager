import type { ConnectionInfo, ConnectionOptions } from '../../../shared/contracts'
import { SnapshotStore } from '../core/store'

/** Connection settings without the password, which the renderer never keeps: a reconnect asks for it again, unless main
 *  remembers one for the same credentials (Remember password) and fills it in itself. */
export type SavedOptions = Omit<ConnectionOptions, 'password'>
/** A connection Object Explorer shows. `lost` means its backend generation ended; only Reconnect replaces it. */
export interface LiveConnection extends ConnectionInfo { readonly options: SavedOptions; readonly lost?: true }

function withoutPassword(options: ConnectionOptions): SavedOptions {
  const saved: ConnectionOptions = { ...options }
  delete saved.password
  return saved
}

// Connection metadata only; the app's connect and disconnect flows own the IPC.
export class ConnectionService extends SnapshotStore<readonly LiveConnection[]> {
  /** Connections from generations before this one are lost. */
  private liveGeneration = 0
  constructor() { super([]) }
  get(id: string): LiveConnection | undefined { return this.getSnapshot().find(connection => connection.id === id) }
  /** Connections that can still run queries. */
  live(): LiveConnection[] { return this.getSnapshot().filter(connection => !connection.lost) }
  /** The connection is still there and was not lost with its backend generation. */
  isLive(id: string): boolean { const connection = this.get(id); return !!connection && !connection.lost }
  add(info: ConnectionInfo, options: ConnectionOptions): void { this.publish([...this.getSnapshot(), this.entry(info, options)]) }
  /** After a reconnect, the new connection takes the lost one's place in Object Explorer. */
  replace(oldId: string, info: ConnectionInfo, options: ConnectionOptions): void {
    const entry = this.entry(info, options), current = this.getSnapshot()
    this.publish(current.some(connection => connection.id === oldId) ? current.map(connection => connection.id === oldId ? entry : connection) : [...current, entry])
  }
  remove(id: string): void { this.publish(this.getSnapshot().filter(connection => connection.id !== id)) }
  /** The backend moved on to `generation`: every connection held by an earlier one is gone with its process. */
  markLostBefore(generation: number): void {
    if (generation <= this.liveGeneration) return
    this.liveGeneration = generation
    const current = this.getSnapshot()
    if (current.some(connection => !connection.lost && connection.generation < generation)) {
      this.publish(current.map(connection => !connection.lost && connection.generation < generation ? { ...connection, lost: true } : connection))
    }
  }
  private entry(info: ConnectionInfo, options: ConnectionOptions): LiveConnection {
    // An answer can arrive after the push that ended its generation.
    return { ...info, options: withoutPassword(options), ...info.generation < this.liveGeneration ? { lost: true } : {} }
  }
  dispose(): void { this.clearListeners(); this.publish([]) }
}
