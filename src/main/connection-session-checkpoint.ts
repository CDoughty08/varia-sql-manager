import type { ConnectionWorkspace } from '../shared/connection-targets'
import type { ConnectionAuthenticationGuard } from './connection-authentication'
import type { WorkspaceSeal } from './connection-workspace-seal'
import type { SessionInput, SessionStore } from './session-store'

interface Capture {
  readonly generation: number
  readonly revision: number
  readonly workspace?: ConnectionWorkspace
  readonly projection: string | undefined
}
const changed = () => new Error('A connection target changed while keeping the session. Review the latest connections before closing the window.')

/** A renderer can stay unchanged while main settles a newer credential revision. Disk and final close must check both. */
export class ConnectionSessionCheckpoint {
  private operation = 0
  private kept?: Capture

  constructor(private readonly authentication: Pick<ConnectionAuthenticationGuard, 'revision' | 'project'>, private readonly store: Pick<SessionStore, 'write' | 'keptBy'>, private readonly credentialsPending: () => boolean = () => false, private readonly beforeCapture: () => Promise<void> = async () => {}, private readonly requireGeneration: (generation: number) => void = () => {}, private readonly seal: (workspace: ConnectionWorkspace | undefined) => Promise<WorkspaceSeal | undefined> = async () => undefined) {}

  async write(session: SessionInput, generation: number, unrestored = false): Promise<void> {
    const operation = ++this.operation
    this.kept = undefined
    await this.beforeCapture()
    this.requireGeneration(generation)
    this.requireIdle()
    if (operation !== this.operation) throw changed()
    const workspace = session.workspace ? this.authentication.project(session.workspace) : undefined
    const capture: Capture = { generation, revision: this.authentication.revision, workspace, projection: JSON.stringify(workspace) }
    // A seal over a projection that changes meanwhile fails current() below, so the written file never outlives its pins.
    const seal = await this.seal(workspace)
    await this.store.write({ ...session, ...workspace ? { workspace } : {}, ...seal ? { seal } : {} }, generation, unrestored)
    this.requireIdle()
    if (operation !== this.operation || !this.current(capture)) throw changed()
    this.kept = capture
  }

  /**
   * Whether `generation`'s close kept a session this checkpoint captured. A later write of the same page that failed (or a
   * close that kept nothing after an aborted one) leaves the store's mark without a capture: that file is not this close's.
   */
  holds(generation: number): boolean { return this.store.keptBy(generation) && this.kept?.generation === generation }

  /** Rechecked after close's final asynchronous cleanup, immediately before closing or quitting. */
  assertCurrent(generation: number): void {
    if (!this.holds(generation)) return
    this.requireIdle()
    if (!this.current(this.kept!)) throw changed()
  }

  private requireIdle(): void {
    if (this.credentialsPending()) throw new Error('Wait for the current connection attempt to finish before keeping or closing the session.')
  }

  private current(capture: Capture): boolean {
    if (capture.revision === this.authentication.revision) return true
    return JSON.stringify(capture.workspace ? this.authentication.project(capture.workspace) : undefined) === capture.projection
  }
}
