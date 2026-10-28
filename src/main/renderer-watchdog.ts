import { readFileSync } from 'node:fs'

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
 * first, so Chromium's own report, which follows an exit at once, wins whenever it comes. Linux can likewise leave an
 * exited renderer unreaped without that event; its zombie PID still exists but no longer runs.
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

/** Whether a process runs: Linux retains an exited, unreaped process's PID, so signal 0 alone also finds zombies. */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0) } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // The comm field is parenthesized and may itself contain spaces, parentheses or newlines. Its final ')' precedes
      // the state and numeric parent PID. No signal is sent, and a zombie cannot have its PID reused until it is reaped.
      const state = stat.startsWith(`${pid} (`) ? /^ ([A-Za-z]) \d+(?:\s|$)/.exec(stat.slice(stat.lastIndexOf(')') + 1))?.[1] : undefined
      if (state === 'Z' || state === 'X' || state === 'x') return false
    } catch { /* An unavailable/restricted procfs does not prove death; the next signal-0 probe can still see an exit. */ }
  }
  return true
}
