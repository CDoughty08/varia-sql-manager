import type { VariaApi } from '../../../shared/contracts'
import { longRunLimits, longRunMessages, type LongRun, type LongRunKind } from '../../../shared/long-runs.ts'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

/** A run in progress: what it is, the connection it runs on, and that connection's server name. */
export interface LongRunEntry extends LongRun { readonly id: number; readonly connectionId: string }
export interface LongRunSnapshot { readonly runs: readonly LongRunEntry[] }
export interface LongRunServiceOptions { readonly api?: Pick<VariaApi, 'setLongRuns'> }

/**
 * The long-run registry (src/shared/long-runs.ts): a run registers while it changes a server, and until it ends the
 * window does not close, its server does not disconnect and the backend does not restart, each refused with a message
 * naming the run. Main learns of the runs (`setLongRuns`) to name them in its reload prompt.
 */
export class LongRunService extends SnapshotStore<LongRunSnapshot> implements Disposable {
  private ids = 0
  private disposed = false

  constructor(private readonly options: LongRunServiceOptions = {}) {
    super({ runs: [] })
  }

  /** Registers a run; disposing the result ends it (once; later calls do nothing). */
  begin(run: { readonly kind: LongRunKind; readonly connectionId: string; readonly server: string }): Disposable {
    const entry: LongRunEntry = { id: ++this.ids, kind: run.kind, connectionId: run.connectionId, server: run.server }
    this.change([...this.getSnapshot().runs, entry])
    let ended = false
    return { dispose: () => { if (ended) return; ended = true; this.change(this.getSnapshot().runs.filter(item => item !== entry)) } }
  }

  /** Why the window may not close now, or undefined. */
  closeRefusal(): string | undefined {
    const run = this.getSnapshot().runs[0]
    return run && longRunMessages.close(run)
  }
  /** Why the connection may not disconnect now (a run on its server), or undefined. */
  disconnectRefusal(connectionId: string): string | undefined {
    const run = this.getSnapshot().runs.find(item => item.connectionId === connectionId)
    return run && longRunMessages.stop(run)
  }
  /** Why the SQL backend may not restart now (any run, since every run is in it), or undefined. */
  restartRefusal(): string | undefined {
    const run = this.getSnapshot().runs[0]
    return run && longRunMessages.stop(run)
  }

  dispose(): void {
    this.disposed = true
    this.clearListeners()
  }

  private change(runs: readonly LongRunEntry[]): void {
    if (this.disposed) return
    this.publish({ runs })
    // Main names the runs in its reload prompt; a failed send leaves its plain prompt, which still asks first.
    const state = { runs: runs.slice(0, longRunLimits.runs).map(run => ({ kind: run.kind, server: run.server.slice(0, longRunLimits.server) })), total: runs.length }
    void this.options.api?.setLongRuns(state).catch(() => {})
  }
}
