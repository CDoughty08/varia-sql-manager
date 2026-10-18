/** The parts of a window's webContents the watchdog reads. */
export interface WatchedContents {
  isDestroyed(): boolean
  isCrashed(): boolean
  getOSProcessId(): number
}

export interface RendererWatchdogOptions {
  /** Whether the OS process `pid` is still running. */
  alive(pid: number): boolean
  /** The renderer process `pid` has exited and Chromium has not noticed. Called once per process. */
  gone(pid: number): void
  intervalMs?: number
  timers?: { setInterval(callback: () => void, ms: number): unknown; clearInterval(timer: unknown): void }
}

export const rendererWatchdogMs = 1000

/**
 * On Windows a process spawned while Chromium launches a renderer inherits every handle inheritable at that moment, the
 * renderer's channel included (Node cannot spawn without passing them: libuv always asks Windows to inherit handles).
 * When that renderer dies, the other process still holds its channel open, so Chromium never sees it go: no
 * render-process-gone, and the window freezes. The watchdog checks the main window's renderer process every
 * `intervalMs` and reports one that has exited while Chromium still says it runs. It waits for a second check in a row
 * first, so Chromium's own report, which follows an exit at once, wins whenever it comes.
 */
export class RendererWatchdog {
  private suspect?: number
  private reported?: number
  private readonly timer: unknown
  private readonly timers: NonNullable<RendererWatchdogOptions['timers']>

  constructor(private readonly contents: WatchedContents, private readonly options: RendererWatchdogOptions) {
    this.timers = options.timers ?? { setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: timer => clearInterval(timer as ReturnType<typeof setInterval>) }
    this.timer = this.timers.setInterval(() => this.check(), options.intervalMs ?? rendererWatchdogMs)
  }

  check(): void {
    if (this.contents.isDestroyed()) { this.stop(); return }
    // No process yet (a renderer being launched) has pid 0.
    const pid = this.contents.getOSProcessId()
    if (!pid || pid === this.reported || this.contents.isCrashed() || this.options.alive(pid)) { this.suspect = undefined; return }
    if (this.suspect !== pid) { this.suspect = pid; return }
    this.suspect = undefined
    this.reported = pid
    this.options.gone(pid)
  }

  stop(): void { this.timers.clearInterval(this.timer) }
}

/** Whether a process runs: signal 0 checks without sending anything (on Windows, that the process has not exited). */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
