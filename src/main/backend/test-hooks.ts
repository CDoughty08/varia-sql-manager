import type { BackendState, ResultDescriptor, SyntheticShape } from '../../shared/contracts'
import type { ResultsPortHost } from './results-port'
import type { BackendSupervisor } from './supervisor'

export interface BackendTestHooks {
  /** Every state the supervisor published, oldest first (at most 200). */
  readonly states: BackendState[]
  state(): BackendState
  pid(): number | undefined
  /** Ends the current backend process the way a crash would (SIGKILL; TerminateProcess on Windows). */
  kill(): number | undefined
  /** Stores synthetic rows (debug.results.synthesize; the backend needs VARIA_BACKEND_TEST_HOOKS=1) that the renderer
   *  may then read, as if a query had returned them. */
  synthesize(shape: SyntheticShape, rows: number): Promise<ResultDescriptor>
}

/** Smoke-test controls on `globalThis.__variaTest`. Main installs them only for unpackaged smoke runs. */
export function installTestHooks(supervisor: BackendSupervisor, results: ResultsPortHost): BackendTestHooks {
  const states: BackendState[] = []
  supervisor.onState(state => { states.push(state); if (states.length > 200) states.shift() })
  const hooks: BackendTestHooks = {
    states,
    state: () => supervisor.state,
    pid: () => supervisor.current?.pid,
    kill: () => {
      const pid = supervisor.current?.pid
      if (pid !== undefined) process.kill(pid, 'SIGKILL')
      return pid
    },
    synthesize: async (shape, rows) => {
      const descriptor = await supervisor.request('debug.results.synthesize', { shape, rows }) as ResultDescriptor
      results.own([descriptor])
      return descriptor
    }
  }
  Object.assign(globalThis, { __variaTest: hooks })
  return hooks
}
