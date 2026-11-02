import type { VariaApi } from '../../../shared/contracts'
import { longRunLimits, longRunMessages, type LongRun, type LongRunKind } from '../../../shared/long-runs.ts'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

/** A run in progress: what it is, the connection it runs on, and that connection's server name. */
export interface LongRunEntry extends LongRun { readonly id: number; readonly connectionId: string }
export interface LongRunSnapshot { readonly runs: readonly LongRunEntry[] }
export interface LongRunServiceOptions { readonly api?: Pick<VariaApi, 'setLongRuns'> }
/** A run as its owner registers it. `refused` shows a refusal made for the run where the user is looking: a run owned
 *  by a modal dialog, which covers the command banner, shows it in the dialog. */
export interface LongRunRegistration { readonly kind: LongRunKind; readonly connectionId: string; readonly server: string; refused?(message: string): void }

/**
 * The long-run registry (src/shared/long-runs.ts): a run registers while it changes a server, and until it ends the
 * window does not close, its server does not disconnect and the backend does not restart, each refused with a message
 * naming the run, which its owner also shows when it gave `refused`. Main learns of the runs (`setLongRuns`) to name
 * them in its reload and restart prompts.
 */
export class LongRunService extends SnapshotStore<LongRunSnapshot> implements Disposable {
  private ids = 0
  private disposed = false
  private readonly owners = new Map<LongRunEntry, (message: string) => void>()

  constructor(private readonly options: LongRunServiceOptions = {}) {
    super({ runs: [] })
  }

  /** Registers a run; disposing the result ends it (once; later calls do nothing). */
  begin(run: LongRunRegistration): Disposable {
    const entry: LongRunEntry = { id: ++this.ids, kind: run.kind, connectionId: run.connectionId, server: run.server }
    if (run.refused) this.owners.set(entry, run.refused)
    this.change([...this.getSnapshot().runs, entry])
    let ended = false
    return { dispose: () => { if (ended) return; ended = true; this.owners.delete(entry); this.change(this.getSnapshot().runs.filter(item => item !== entry)) } }
  }

  /** Why the window may not close now, or undefined. The close is refused, so the run's owner shows it too. */
  closeRefusal(): string | undefined {
    const run = this.getSnapshot().runs[0]
    return run && this.refuse(run, longRunMessages.close(run))
  }
  /** Why the connection may not disconnect now (a run on its server), or undefined. Menus and pickers ask it too, so it
   *  tells no owner. */
  disconnectRefusal(connectionId: string): string | undefined {
    const run = this.getSnapshot().runs.find(item => item.connectionId === connectionId)
    return run && longRunMessages.stop(run)
  }
  /** Why the SQL backend may not restart now (any run, since every run is in it), or undefined. The restart is refused,
   *  so the run's owner shows it too. */
  restartRefusal(): string | undefined {
    const run = this.getSnapshot().runs[0]
    return run && this.refuse(run, longRunMessages.stop(run))
  }

  dispose(): void {
    this.disposed = true
    this.owners.clear()
    this.clearListeners()
  }

  private refuse(run: LongRunEntry, message: string): string {
    // A failing owner is reported; the refusal still goes to the banner.
    try { this.owners.get(run)?.(message) } catch (error) { onUnexpectedError(error) }
    return message
  }

  private change(runs: readonly LongRunEntry[]): void {
    if (this.disposed) return
    this.publish({ runs })
    // Main names the runs in its reload prompt; a failed send leaves its plain prompt, which still asks first.
    const state = { runs: runs.slice(0, longRunLimits.runs).map(run => ({ kind: run.kind, server: run.server.slice(0, longRunLimits.server) })), total: runs.length }
    void this.options.api?.setLongRuns(state).catch(() => {})
  }
}
