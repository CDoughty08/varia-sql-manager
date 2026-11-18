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

/** The smallest rectangle holding every one of `areas`. */
function span(areas: readonly Rect[]): Rect {
  const left = Math.min(...areas.map(area => area.x)), top = Math.min(...areas.map(area => area.y))
  const right = Math.max(...areas.map(area => area.x + area.width)), bottom = Math.max(...areas.map(area => area.y + area.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
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
 * to the work areas it overlaps if it no longer fits them (moved inside them if it shrank), so one stretched across
 * adjacent displays keeps its size; one whose display is gone, whose layout or
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
    // A window stretched across adjacent displays may keep that size: the room is every work area it overlaps.
    const room = span([home, ...areas.filter(area => overlap(saved, area) > 0)])
    const width = fit(saved.width, minWidth, room.width), height = fit(saved.height, minHeight, room.height)
    if (width === saved.width && height === saved.height) return { bounds: { x: saved.x, y: saved.y, width, height }, maximized, outcome: 'restored' }
    // It shrank (or grew to its minimum): keep its corner where it was but inside that room, as long as its title bar is
    // still on a display there (a room spanning staggered displays has gaps); otherwise it moves like a lost window.
    const x = Math.min(Math.max(saved.x, room.x), room.x + room.width - width), y = Math.min(Math.max(saved.y, room.y), room.y + room.height - height)
    if (grabArea({ x, y, width, height }, areas)) return { bounds: { x, y, width, height }, maximized, outcome: 'resized' }
  }
  const area = nearestArea(saved, areas, primary)
  return { bounds: centred(area, fit(saved.width, minWidth, area.width), fit(saved.height, minHeight, area.height)), maximized, outcome: 'moved' }
}

/**
 * Whether this Linux process runs on Wayland, where a window cannot choose its own position, by Chromium's platform choice:
 * `--ozone-platform` decides when given; the `wayland` hint needs a Wayland display; the `auto` hint (Electron's default)
 * follows the session type, so an X11 session that also exports `WAYLAND_DISPLAY` (WSLg) stays X11. Erring towards
 * Wayland only costs a session its saved position, never a window placed off screen.
 */
export function onWayland(platform: NodeJS.Platform, switches: { ozonePlatform: string; ozonePlatformHint: string }, env: NodeJS.ProcessEnv): boolean {
  if (platform !== 'linux') return false
  if (switches.ozonePlatform) return switches.ozonePlatform === 'wayland'
  if (switches.ozonePlatformHint === 'x11') return false
  if (switches.ozonePlatformHint === 'wayland') return !!(env.WAYLAND_DISPLAY || env.WAYLAND_SOCKET)
  return env.XDG_SESSION_TYPE === 'wayland'
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
  on(event: 'move' | 'resize' | 'maximize' | 'unmaximize' | 'minimize' | 'restore' | 'enter-full-screen' | 'leave-full-screen' | 'close' | 'closed', listener: () => void): unknown
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
  // The state last handed to the store (or read from it); a save that fails clears it, so the same state is tried again.
  private stored: SavedWindowState | undefined
  private timer: { window: TrackedWindow; handle: ReturnType<typeof setTimeout> } | undefined
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly options: TrackerOptions, initial?: SavedWindowState) { this.latest = this.stored = initial }
  current(): SavedWindowState | undefined { return this.latest }

  /** `placed` is where the window was created, which a window opened maximized on Linux has no other record of. */
  track(window: TrackedWindow, placed?: Rect): void {
    const linux = this.options.platform === 'linux'
    const isNormal = () => !window.isMaximized() && !window.isMinimized() && !window.isFullScreen()
    const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
    // The window's normal bounds, kept up to date because full screen reports none worth having (Windows gives the maximized
    // rectangle, or one off by a pixel). Windows and macOS report reliable normal bounds while maximized or minimized. On
    // Linux the bounds of a change can arrive before its state (an X11 window manager's resize before its maximized flag),
    // so bounds seen while normal are only a candidate until they settle or the window leaves the normal state at bounds
    // other than these.
    let normal: Rect | undefined = isNormal() ? window.getBounds() : linux ? placed ?? window.getNormalBounds() : window.getNormalBounds()
    // The last two: X11's resize to the maximized size, seen while still normal, may follow the move that matters.
    let candidate: Rect | undefined, earlier: Rect | undefined
    let maximized = window.isMaximized()
    const refresh = (settled: boolean) => {
      if (window.isDestroyed() || window.isFullScreen()) return
      if (isNormal()) {
        if (settled || !linux) { normal = window.getBounds(); candidate = earlier = undefined }
        else { const bounds = window.getBounds(); if (!candidate || !same(candidate, bounds)) { earlier = candidate; candidate = bounds } }
      } else if (!linux) normal = window.getNormalBounds()
    }
    // Linux, a candidate the window left the normal state at: either the maximized size reported before the flag (it stays
    // the window's size, and `earlier` was the normal place) or the normal place itself with the new size still to come.
    // The first change of bounds after it decides: the maximize's own resize changes the size in the same state; anything
    // else (a move to another display, full screen, a minimize) means the size had come first.
    let undecided: { candidate: Rect; earlier?: Rect; maximized: boolean; fullScreen: boolean } | undefined
    /** The window is not normal: decide what its last bounds while normal were. */
    const left = () => {
      if (window.isDestroyed()) return
      const now = window.getBounds()
      if (undecided && !same(now, undecided.candidate)) {
        const sameState = window.isMaximized() === undecided.maximized && window.isFullScreen() === undecided.fullScreen && !window.isMinimized()
        if (sameState && (now.width !== undecided.candidate.width || now.height !== undecided.candidate.height)) { normal = undecided.candidate; undecided = undefined }
        else decide()
      }
      if (!candidate) return
      // Minimizing keeps the window's bounds, so the bounds it has are the place it was minimized from.
      if (window.isMinimized() && !window.isMaximized() && !window.isFullScreen()) normal = candidate
      else if (!same(candidate, now)) normal = candidate
      else undecided = { candidate, earlier, maximized: window.isMaximized(), fullScreen: window.isFullScreen() }
      candidate = earlier = undefined
    }
    /** Nothing changed the size since: the undecided candidate was the maximized size, reported early. */
    const decide = () => {
      // An earlier candidate of the same size was the same early maximized size, at the position before the window manager moved it.
      const earlier = undecided?.earlier
      if (earlier && (earlier.width !== undecided?.candidate.width || earlier.height !== undecided.candidate.height)) normal = earlier
      undecided = undefined
    }
    const capture = (): SavedWindowState | undefined => {
      if (window.isDestroyed()) return undefined
      const fullScreen = window.isFullScreen(), minimized = window.isMinimized()
      if (!fullScreen && !minimized) maximized = window.isMaximized()
      let bounds: Rect
      if (isNormal()) bounds = window.getBounds()
      else if (fullScreen || linux) bounds = normal ?? window.getNormalBounds()
      else bounds = window.getNormalBounds()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized }
    }
    // What the window looked like at its last event, for a window destroyed (not closed) before its pending save ran.
    let seen: SavedWindowState | undefined
    const changed = () => {
      if (window.isDestroyed()) return
      if (!isNormal()) left()
      refresh(false)
      seen = capture()
      this.schedule(window, () => {
        if (window.isDestroyed()) return undefined
        if (isNormal()) undecided = undefined
        else { left(); decide() }
        refresh(true)
        return capture()
      })
    }
    window.on('move', changed)
    window.on('resize', changed)
    // In full screen Windows reports maximize as it enters and leaves; the flag is what the window was before full screen.
    window.on('maximize', () => { if (!window.isFullScreen()) maximized = true; changed() })
    window.on('unmaximize', () => { if (!window.isFullScreen()) maximized = false; changed() })
    window.on('enter-full-screen', changed)
    window.on('leave-full-screen', changed)
    window.on('minimize', changed)
    window.on('restore', changed)
    window.on('close', () => { this.cancel(window); if (!isNormal()) { left(); decide() } this.write(capture()) })
    window.on('closed', () => { if (this.cancel(window)) this.write(seen) })
  }

  /** Waits for the writes started so far, at most `flushMs`; never rejects. */
  flush(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, windowStateLimits.flushMs) })
    return Promise.race([this.writes, limit]).finally(() => clearTimeout(timer))
  }

  private schedule(window: TrackedWindow, run: () => SavedWindowState | undefined): void {
    if (this.timer) clearTimeout(this.timer.handle)
    const handle = setTimeout(() => { this.timer = undefined; this.write(run()) }, this.options.delayMs ?? windowStateLimits.saveDelayMs)
    this.timer = { window, handle }
  }
  /** Drops `window`'s pending save, if it had one; a window that replaced it keeps its own. */
  private cancel(window: TrackedWindow): boolean {
    if (this.timer?.window !== window) return false
    clearTimeout(this.timer.handle)
    this.timer = undefined
    return true
  }
  private write(state: SavedWindowState | undefined): void {
    if (!state) return
    this.latest = state
    const previous = this.stored
    if (previous && previous.x === state.x && previous.y === state.y && previous.width === state.width && previous.height === state.height && previous.maximized === state.maximized) return
    this.stored = state
    this.writes = this.writes.then(() => this.options.save(state)).catch(() => { if (this.stored === state) this.stored = undefined })
  }
}
