import type { BackendState } from '../../shared/contracts'
import type { BackendSupervisor } from './supervisor'

export interface BackendTestHooks {
  /** Every state the supervisor published, oldest first (at most 200). */
  readonly states: BackendState[]
  state(): BackendState
  pid(): number | undefined
  /** Ends the current backend process the way a crash would (SIGKILL; TerminateProcess on Windows). */
  kill(): number | undefined
}

/** Smoke-test controls on `globalThis.__variaTest`. Main installs them only for unpackaged smoke runs. */
export function installTestHooks(supervisor: BackendSupervisor): BackendTestHooks {
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
    }
  }
  Object.assign(globalThis, { __variaTest: hooks })
  return hooks
}
