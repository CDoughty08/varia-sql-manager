import { z } from 'zod'
import { quarantine, readJsonFile, writeJsonAtomic } from './json-file'

/**
 * The main window's place between runs: `<userData>/window-state.json`, written only by main. The saved rectangle is the
 * window's normal (restored) bounds in screen DIPs; maximized is a flag on top. Minimized and full screen are never kept:
 * a window closed minimized reopens normal (or maximized), one closed in full screen reopens as it was before full screen.
 * Nothing saved is trusted: `placeWindow` checks it against the displays connected now.
 */
export interface Rect { x: number; y: number; width: number; height: number }
export interface SavedWindowState extends Rect { maximized: boolean }

export const mainWindowLimits = {
  defaultWidth: 1440,
  defaultHeight: 960,
  minWidth: 1024,
  minHeight: 700,
  /** How much of the window's top edge must lie on one display's work area for it to stay where it was: enough to grab. */
  grabWidth: 160,
  grabHeight: 40,
  /** Anything outside these is corrupt rather than a real place. */
  maxCoordinate: 1_000_000,
  maxSize: 100_000
} as const
export const windowStateLimits = { fileBytes: 4096, saveDelayMs: 750, flushMs: 2000 } as const

const coordinate = z.number().finite().min(-mainWindowLimits.maxCoordinate).max(mainWindowLimits.maxCoordinate)
const size = z.number().finite().min(1).max(mainWindowLimits.maxSize)
const savedSchema = z.object({ x: coordinate, y: coordinate, width: size, height: size, maximized: z.boolean() }).strict()
const fileSchema = z.object({ version: z.literal(1), main: savedSchema }).strict()

/** The saved main window state, or undefined for anything that is not exactly a version 1 file's. */
export function parseWindowStateFile(value: unknown): SavedWindowState | undefined {
  const parsed = fileSchema.safeParse(value)
  if (!parsed.success) return undefined
  const { x, y, width, height, maximized } = parsed.data.main
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), maximized }
}

export interface DisplayAreas {
  /** Every connected display's work area (`screen.getAllDisplays()`), in DIPs. */
  readonly workAreas: readonly Rect[]
  /** The primary display's work area. */
  readonly primary: Rect
}
export interface WindowPlacement {
  /** Bounds to create the window with; without `x` and `y` the window system places it. */
  readonly bounds: { x?: number; y?: number; width: number; height: number }
  readonly maximized: boolean
  /** How the saved state was used, for tests and diagnostics. */
  readonly outcome: 'default' | 'restored' | 'resized' | 'moved' | 'sizeOnly'
}
export interface PlaceOptions {
  /** False where windows cannot place themselves (Wayland): only the size and the maximized flag are restored. */
  readonly canPosition: boolean
}

const validArea = (area: Rect) => [area.x, area.y, area.width, area.height].every(Number.isFinite) && area.width > 0 && area.height > 0
/** A size within the work area and, as far as the area allows, at least the window's minimum. */
const fit = (wanted: number, minimum: number, available: number) => Math.round(Math.max(Math.min(wanted, available), Math.min(minimum, available)))
const centred = (area: Rect, width: number, height: number): Rect => ({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height })
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
const distance = (rect: Rect, area: Rect) => {
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2
  const dx = Math.max(area.x - cx, 0, cx - (area.x + area.width)), dy = Math.max(area.y - cy, 0, cy - (area.y + area.height))
  return dx * dx + dy * dy
}

/** The work area that holds a grabbable part of the window's top edge (its title bar), if any. */
export function grabArea(rect: Rect, workAreas: readonly Rect[]): Rect | undefined {
  const { grabWidth, grabHeight } = mainWindowLimits
  return workAreas.find(area => {
    const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)
    const top = rect.y >= area.y && rect.y <= area.y + area.height - grabHeight
    return top && width >= Math.min(grabWidth, rect.width)
  })
}

/** The work area a window that is not on any display moves to: the one it overlaps most, else the closest to its centre. */
function nearestArea(rect: Rect, workAreas: readonly Rect[], primary: Rect): Rect {
  let best = primary, bestOverlap = 0
  for (const area of workAreas) {
    const shared = overlap(rect, area)
    if (shared > bestOverlap) { best = area; bestOverlap = shared }
  }
  if (bestOverlap > 0) return best
  let bestDistance = Infinity
  for (const area of workAreas) {
    const d = distance(rect, area)
    if (d < bestDistance) { best = area; bestDistance = d }
  }
  return best
}

/**
 * Where the main window opens: the saved state when it is still reachable on a connected display, else the nearest display,
 * else the default size centred on the primary display. A window whose title bar is on a display stays where it was, shrunk
 * to that display's work area if it no longer fits (moved inside it if it shrank); one whose display is gone, whose layout or
 * scale changed so its title bar is off every work area, or that sits under the macOS menu bar, is centred on the nearest
 * display at its saved size (clamped to that work area). Sizes never go below the window's minimum unless the work area is
 * smaller still.
 */
export function placeWindow(saved: SavedWindowState | undefined, displays: DisplayAreas, options: PlaceOptions): WindowPlacement {
  const { defaultWidth, defaultHeight, minWidth, minHeight } = mainWindowLimits
  const workAreas = displays.workAreas.filter(validArea)
  const primary = validArea(displays.primary) ? displays.primary : workAreas[0]
  const maximized = saved?.maximized ?? false
  // No display to measure against: leave the place to the window system.
  if (!primary) return { bounds: { width: saved?.width ?? defaultWidth, height: saved?.height ?? defaultHeight }, maximized, outcome: saved ? 'sizeOnly' : 'default' }
  const areas = workAreas.length ? workAreas : [primary]
  if (!saved) return { bounds: centred(primary, fit(defaultWidth, minWidth, primary.width), fit(defaultHeight, minHeight, primary.height)), maximized: false, outcome: 'default' }
  if (!options.canPosition) {
    // The compositor chooses the display; any size that fits the largest one is fine there.
    const widest = Math.max(...areas.map(area => area.width)), tallest = Math.max(...areas.map(area => area.height))
    return { bounds: { width: fit(saved.width, minWidth, widest), height: fit(saved.height, minHeight, tallest) }, maximized, outcome: 'sizeOnly' }
  }
  const home = grabArea(saved, areas)
  if (home) {
    const width = fit(saved.width, minWidth, home.width), height = fit(saved.height, minHeight, home.height)
    if (width === saved.width && height === saved.height) return { bounds: { x: saved.x, y: saved.y, width, height }, maximized, outcome: 'restored' }
    // It shrank (or grew to its minimum): keep its corner where it was but inside the work area.
    const x = Math.min(Math.max(saved.x, home.x), home.x + home.width - width), y = Math.min(Math.max(saved.y, home.y), home.y + home.height - height)
    return { bounds: { x, y, width, height }, maximized, outcome: 'resized' }
  }
  const area = nearestArea(saved, areas, primary)
  return { bounds: centred(area, fit(saved.width, minWidth, area.width), fit(saved.height, minHeight, area.height)), maximized, outcome: 'moved' }
}

/**
 * Whether this Linux process may run on Wayland, where a window cannot choose its own position. Electron uses Wayland when
 * `--ozone-platform=wayland`, or when the hint is auto (Electron's default) and a Wayland display is available. Erring
 * towards Wayland only costs an X11 session its saved position, never a window placed off screen.
 */
export function onWayland(platform: NodeJS.Platform, switches: { ozonePlatform: string; ozonePlatformHint: string }, env: NodeJS.ProcessEnv): boolean {
  if (platform !== 'linux') return false
  if (switches.ozonePlatform) return switches.ozonePlatform === 'wayland'
  if (switches.ozonePlatformHint === 'x11') return false
  return !!env.WAYLAND_DISPLAY
}

/**
 * `<userData>/window-state.json`. Reads and writes run one at a time. An invalid file is quarantined and the default place
 * used; a file that cannot be read (permissions, a folder at the path) is never written this session, so it is not replaced.
 */
export class WindowStateStore {
  private queue: Promise<void> = Promise.resolve()
  private unreadable = false
  constructor(private readonly path: string) {}
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.then(() => {}, () => {})
    return next
  }
  load(): Promise<SavedWindowState | undefined> {
    return this.serial(async () => {
      let read
      try { read = await readJsonFile(this.path, windowStateLimits.fileBytes) } catch { this.unreadable = true; return undefined }
      if (read.kind === 'missing') return undefined
      const state = read.kind === 'ok' ? parseWindowStateFile(read.value) : undefined
      if (!state) await quarantine(this.path).catch(() => { this.unreadable = true })
      return state
    })
  }
  save(state: SavedWindowState): Promise<void> {
    if (this.unreadable) return Promise.resolve()
    const file = { version: 1 as const, main: { x: Math.round(state.x), y: Math.round(state.y), width: Math.round(state.width), height: Math.round(state.height), maximized: state.maximized } }
    if (!parseWindowStateFile(file)) return Promise.resolve()
    return this.serial(() => writeJsonAtomic(this.path, file, windowStateLimits.fileBytes, 'Window state exceeds its size limit.'))
  }
}

/** The parts of the main `BrowserWindow` the tracker reads, so tests can pass a fake. */
export interface TrackedWindow {
  getBounds(): Rect
  getNormalBounds(): Rect
  isMaximized(): boolean
  isMinimized(): boolean
  isFullScreen(): boolean
  isDestroyed(): boolean
  on(event: 'move' | 'resize' | 'maximize' | 'unmaximize' | 'enter-full-screen' | 'leave-full-screen' | 'close' | 'closed', listener: () => void): unknown
}
export interface TrackerOptions {
  readonly platform: NodeJS.Platform
  readonly save: (state: SavedWindowState) => Promise<void>
  readonly delayMs?: number
}

/**
 * Follows the main window and saves its place: a short while after it stops moving or resizing, and at once when it closes.
 * `current()` is the latest place, which a window reopened in the same run (macOS) starts from.
 */
export class WindowStateTracker {
  private latest: SavedWindowState | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly options: TrackerOptions, initial?: SavedWindowState) { this.latest = initial }
  current(): SavedWindowState | undefined { return this.latest }

  track(window: TrackedWindow): void {
    // The last bounds seen while the window was normal: full screen (and Linux's maximize) report no reliable normal bounds.
    let normal: Rect | undefined = window.isMaximized() || window.isMinimized() || window.isFullScreen() ? undefined : window.getBounds()
    let maximized = window.isMaximized()
    const isNormal = () => !window.isMaximized() && !window.isMinimized() && !window.isFullScreen()
    const capture = (): SavedWindowState | undefined => {
      if (window.isDestroyed()) return undefined
      const fullScreen = window.isFullScreen(), minimized = window.isMinimized()
      if (!fullScreen && !minimized) maximized = window.isMaximized()
      let bounds: Rect
      if (isNormal()) bounds = window.getBounds()
      else if (fullScreen || this.options.platform === 'linux') bounds = normal ?? window.getNormalBounds()
      else bounds = window.getNormalBounds()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized }
    }
    const changed = () => {
      if (window.isDestroyed()) return
      if (isNormal()) normal = window.getBounds()
      this.schedule(capture)
    }
    window.on('move', changed)
    window.on('resize', changed)
    window.on('maximize', () => { if (!window.isFullScreen()) maximized = true; changed() })
    window.on('unmaximize', () => { if (!window.isFullScreen()) maximized = false; changed() })
    window.on('enter-full-screen', changed)
    window.on('leave-full-screen', changed)
    window.on('close', () => { this.cancel(); this.write(capture()) })
    window.on('closed', () => this.cancel())
  }

  /** Waits for the writes started so far, at most `flushMs`; never rejects. */
  flush(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, windowStateLimits.flushMs) })
    return Promise.race([this.writes, limit]).finally(() => clearTimeout(timer))
  }

  private schedule(capture: () => SavedWindowState | undefined): void {
    this.cancel()
    this.timer = setTimeout(() => { this.timer = undefined; this.write(capture()) }, this.options.delayMs ?? windowStateLimits.saveDelayMs)
  }
  private cancel(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined } }
  private write(state: SavedWindowState | undefined): void {
    if (!state) return
    const previous = this.latest
    this.latest = state
    if (previous && previous.x === state.x && previous.y === state.y && previous.width === state.width && previous.height === state.height && previous.maximized === state.maximized) return
    this.writes = this.writes.then(() => this.options.save(state)).catch(() => {})
  }
}
