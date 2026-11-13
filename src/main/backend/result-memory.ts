import type { BackendMethods, BackendState } from '../../shared/contracts'
import { resultsMemoryLimitSchema } from '../validation'

type LimitParams = BackendMethods['results.setMemoryLimit']['params']

/** The params for Tools › Options' result memory limit as the setting holds it: anything but a whole number of GiB is
 *  automatic (0), as at launch (resultMemoryEnvironment), and more than 1024 is 1024. */
export function resultMemoryLimitParams(limitGiB: unknown): LimitParams {
  const value = typeof limitGiB === 'number' && Number.isInteger(limitGiB) && limitGiB > 0 ? Math.min(limitGiB, 1024) : 0
  return resultsMemoryLimitSchema.parse({ limitGiB: value })
}

export interface ResultMemoryLimitDeps {
  /** The supervisor's request, bound to one generation so a later one is never sent another's figure. */
  request(params: LimitParams, generation: number): Promise<unknown>
  onState(listener: (state: BackendState) => void): () => void
  /** The setting's current value (`queryResults.grid.memoryLimitGiB`). */
  read(): unknown
}

/** Applies the result memory limit to the running backend (results.setMemoryLimit) when the setting changes and as each
 *  backend generation becomes ready: a launch already carries it in its environment, but the setting may change between
 *  the spawn and the backend's HELLO. One request is in flight at a time, so a later value never arrives before an
 *  earlier one; a value is sent again only when it differs from the last one the generation applied. A failure is a
 *  value: a value set while it was in flight is still sent, and otherwise the next change, the generation's recovery
 *  from unresponsive, or the next launch sends again (a new request each time; none is re-sent). */
export class ResultMemoryLimit {
  private generation: number | undefined
  private applied: number | undefined
  private sending = false
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private readonly deps: ResultMemoryLimitDeps) {
    this.unsubscribe = deps.onState(state => {
      if (state.status === 'ready') {
        // Ready again after unresponsive: a value whose request failed meanwhile is sent now.
        if (state.generation === this.generation) return void this.flush()
        this.generation = state.generation
        this.applied = undefined
        void this.flush()
      } else if (state.status !== 'unresponsive') this.generation = undefined
    })
  }

  /** The settings changed: sends the limit if it differs from what the ready generation applied. */
  settingsChanged(): void { void this.flush() }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  private async flush(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      for (;;) {
        const generation = this.generation
        const params = resultMemoryLimitParams(this.deps.read())
        if (this.disposed || generation === undefined || params.limitGiB === this.applied) return
        const sent = await this.deps.request(params, generation).then(() => true, () => false)
        // A generation that went meanwhile is the next one's to apply.
        if (this.generation !== generation) continue
        if (sent) this.applied = params.limitGiB
        // A failure waits for the next change or recovery, unless a newer value was set while it was in flight.
        else if (resultMemoryLimitParams(this.deps.read()).limitGiB === params.limitGiB) return
      }
    } finally {
      this.sending = false
    }
  }
}
