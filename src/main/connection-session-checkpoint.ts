import type { ConnectionWorkspace } from '../shared/connection-targets'
import type { ConnectionAuthenticationGuard } from './connection-authentication'
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

  constructor(private readonly authentication: Pick<ConnectionAuthenticationGuard, 'revision' | 'project'>, private readonly store: Pick<SessionStore, 'write' | 'keptBy'>, private readonly credentialsPending: () => boolean = () => false) {}

  async write(session: SessionInput, generation: number): Promise<void> {
    this.requireIdle()
    const operation = ++this.operation
    this.kept = undefined
    const workspace = session.workspace ? this.authentication.project(session.workspace) : undefined
    const capture: Capture = { generation, revision: this.authentication.revision, workspace, projection: JSON.stringify(workspace) }
    await this.store.write({ ...session, ...workspace ? { workspace } : {} }, generation)
    this.requireIdle()
    if (operation !== this.operation || !this.current(capture)) throw changed()
    this.kept = capture
  }

  /** Rechecked after close's final asynchronous cleanup, immediately before closing or quitting. */
  assertCurrent(generation: number): void {
    if (this.store.keptBy(generation)) this.requireIdle()
    if (this.store.keptBy(generation) && (!this.kept || this.kept.generation !== generation || !this.current(this.kept))) throw changed()
  }

  private requireIdle(): void {
    if (this.credentialsPending()) throw new Error('Wait for the current connection attempt to finish before keeping or closing the session.')
  }

  private current(capture: Capture): boolean {
    if (capture.revision === this.authentication.revision) return true
    return JSON.stringify(capture.workspace ? this.authentication.project(capture.workspace) : undefined) === capture.projection
  }
}
