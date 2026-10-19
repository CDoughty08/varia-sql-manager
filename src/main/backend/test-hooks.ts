import { spawn, type ChildProcess } from 'node:child_process'
import type { BackendState, ResultDescriptor, SyntheticShape } from '../../shared/contracts'
import type { ResultsPortHost } from './results-port'
import type { BackendSupervisor } from './supervisor'

/** Who reported a lost renderer: Chromium (render-process-gone) or main's watchdog. */
export type RendererLossSource = 'event' | 'watchdog'
/** What spawns at the next renderer launch: the backend's next generation, or an idle process. */
export type RendererHolder = 'backend' | 'process'

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
  /** Reports of a lost renderer, oldest first (at most 200), and whether main handled each (once per renderer). */
  readonly rendererLosses: { source: RendererLossSource; handled: boolean }[]
  rendererLoss(source: RendererLossSource, handled: boolean): void
  /**
   * Spawns `holder` when the next page navigation starts, as Chromium launches a renderer for it after a crash. On
   * Windows the spawned process inherits that renderer's channel, so its next crash raises no render-process-gone:
   * what a backend restart at that moment did before main stopped doing it (only the watchdog then sees the crash).
   */
  holdNextRenderer(holder: RendererHolder): void
  /** Main calls this as a main-frame navigation starts. */
  navigationStarted(): void
  /** Ends the idle holder processes; returns how many there were. */
  releaseHolders(): number
}

/** Smoke-test controls on `globalThis.__variaTest`. Main installs them only for unpackaged smoke runs. */
export function installTestHooks(supervisor: BackendSupervisor, results: ResultsPortHost): BackendTestHooks {
  const states: BackendState[] = []
  supervisor.onState(state => { states.push(state); if (states.length > 200) states.shift() })
  const rendererLosses: BackendTestHooks['rendererLosses'] = []
  const holders = new Set<ChildProcess>()
  let armed: RendererHolder | undefined
  const release = () => { const count = holders.size; for (const holder of holders) holder.kill(); holders.clear(); return count }
  process.once('exit', release)
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
    },
    rendererLosses,
    rendererLoss: (source, handled) => { rendererLosses.push({ source, handled }); if (rendererLosses.length > 200) rendererLosses.shift() },
    holdNextRenderer: holder => { armed = holder },
    navigationStarted: () => {
      const holder = armed
      armed = undefined
      // Spawned now, in the navigation's own event, as the backend restart was.
      if (holder === 'backend') void supervisor.restart('reload')
      if (holder !== 'process') return
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true })
      holders.add(child)
      child.once('exit', () => holders.delete(child))
    },
    releaseHolders: release
  }
  Object.assign(globalThis, { __variaTest: hooks })
  return hooks
}
