import { popoutLimits, popoutWindowName } from '../shared/popouts'
import { UserActivation } from './window-roles'

export interface Bounds { x: number; y: number; width: number; height: number }
/** The window-open details main sees for a page's `window.open` (Electron's `HandlerDetails`, the fields used here). */
export interface OpenDetails { readonly url: string; readonly frameName: string; readonly features: string; readonly disposition: string }

const featurePattern = /^left=(-?\d{1,6}),top=(-?\d{1,6}),width=(\d{1,5}),height=(\d{1,5})$/
/**
 * The bounds a popout request asks for, or undefined when it is not one: only a new `about:blank` window with Varia's
 * popout name and exactly `left`, `top`, `width` and `height`, as `DockWorkspace` in the renderer opens it. Anything else the
 * page opens is denied, as before.
 */
export function popoutRequest(details: OpenDetails): Bounds | undefined {
  if (details.url !== 'about:blank' || details.disposition !== 'new-window' || !popoutWindowName.test(details.frameName)) return undefined
  const match = featurePattern.exec(details.features)
  if (!match) return undefined
  const [x, y, width, height] = match.slice(1).map(Number)
  if (width < popoutLimits.minWidth || height < popoutLimits.minHeight || width > popoutLimits.maxSize || height > popoutLimits.maxSize) return undefined
  return { x, y, width, height }
}

/** Whether enough of `bounds` lies on one display's work area to grab the window there: its top strip, at least. */
export function onDisplay(bounds: Bounds, workAreas: readonly Bounds[]): boolean {
  return workAreas.some(area => {
    const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    const top = bounds.y >= area.y && bounds.y < area.y + area.height - popoutLimits.grabHeight
    return width >= popoutLimits.grabWidth && top
  })
}

/** Electron's zoom factor for a zoom level (each level is 20 %). */
export const zoomFactor = (level: number): number => Math.pow(1.2, level)
/** Bounds in the page's CSS pixels as screen DIPs, at the page's zoom factor. */
export function scaleBounds(bounds: Bounds, factor: number): Bounds {
  const scale = Number.isFinite(factor) && factor > 0 ? factor : 1
  return { x: Math.round(bounds.x * scale), y: Math.round(bounds.y * scale), width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) }
}

/** The parts of a popout `BrowserWindow` the registry uses, so tests can pass a fake. */
export interface PopoutWindow {
  readonly id: number
  isDestroyed(): boolean
  isFocused(): boolean
  isMinimized(): boolean
  /** Shows (restores) the window without activating it. */
  showInactive(): void
  /** Puts the window on top of the others without activating it. */
  moveTop(): void
  destroy(): void
  setMenuBarVisibility(visible: boolean): void
  setAutoHideMenuBar(hide: boolean): void
  on(event: 'closed', listener: () => void): void
  readonly webContents: {
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    on(event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }) => void): void
    on(event: 'input-event', listener: (event: unknown, input: { type: string }) => void): void
    on(event: 'zoom-changed', listener: () => void): void
    setZoomLevel(level: number): void
    getZoomLevel(): number
  }
}

/**
 * The windows the trusted page opened for its popped-out panels. Each is the page's own same-origin `about:blank` child:
 * it runs in the page's renderer, inside the same sandbox and isolation, has no preload (so no `window.varia` and no IPC
 * of its own: `trusted()` still accepts only the main window's main frame), denies popups and navigation, and goes when
 * the page that opened it reloads, crashes or closes, since its content is that page's.
 */
/** How long an allowed popout counts against the limit before Electron creates it. */
const pendingMs = 10_000

export class PopoutWindows<W extends PopoutWindow> {
  private readonly windows = new Map<number, { window: W; activation: UserActivation; name?: string }>()
  /** When each allowed window that Electron has not created yet was allowed: they count against the limit too. */
  private pending: number[] = []
  constructor(private readonly options: {
    readonly platform: NodeJS.Platform
    /** The displays' work areas now, where a restored window must still land. */
    workAreas(): readonly Bounds[]
    /** The main window's zoom, which every popout shares. */
    zoomLevel(): number
    /** Sets the main window's zoom: a popout zoomed by Ctrl+wheel or a pinch takes the main window, and so every popout, with it. */
    setZoomLevel(level: number): void
    /** Called when the first popout opens and when the last one goes. */
    changed(open: number): void
    /** The clock pending windows expire by (tests pass their own). */
    now?(): number
  }) {}
  private now(): number { return this.options.now?.() ?? Date.now() }

  /** `allow` with the window's options for a popout request on a display; `deny` for anything else. */
  open(details: OpenDetails, base: { readonly backgroundColor: string; readonly show: boolean }): { action: 'deny' } | { action: 'allow'; overrideBrowserWindowOptions: Record<string, unknown> } {
    const requested = popoutRequest(details)
    if (!requested) return { action: 'deny' }
    // The page measures in CSS pixels, which its zoom scales; windows are placed in screen DIPs.
    const bounds = scaleBounds(requested, zoomFactor(this.options.zoomLevel()))
    // An allowed window Electron failed to create never arrives: it stops counting after a while.
    const now = this.now()
    this.pending = this.pending.filter(at => now - at < pendingMs)
    if (this.windows.size + this.pending.length >= popoutLimits.maxWindows || !onDisplay(bounds, this.options.workAreas())) return { action: 'deny' }
    this.pending.push(now)
    return { action: 'allow', overrideBrowserWindowOptions: {
      ...bounds, useContentSize: true, minWidth: popoutLimits.minWidth, minHeight: popoutLimits.minHeight, show: base.show, backgroundColor: base.backgroundColor,
      autoHideMenuBar: false, title: 'Varia SQL Manager',
      // Explicit, not inherited: no preload, the same sandbox and isolation, no Node, and no test arguments.
      webPreferences: { preload: undefined, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, additionalArguments: [], devTools: true }
    } }
  }

  /** Takes a window `open` allowed: it denies popups and navigation, counts its own input for Paste, and shares the zoom.
   *  `name` is the frame name the page opened it with (`varia-popout-<uuid>`), by which the page asks to raise it. */
  adopt(window: W, name?: string): void {
    const activation = new UserActivation()
    this.pending.shift()
    this.windows.set(window.id, { window, activation, ...name !== undefined && popoutWindowName.test(name) ? { name } : {} })
    const contents = window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect'] as const) contents.on(event, navigation => navigation.preventDefault())
    contents.on('input-event', (_event, input) => activation.note(input.type))
    // The application menu stays hidden, as on the main window; it still serves Electron's role keys there.
    if (this.options.platform !== 'darwin') { window.setAutoHideMenuBar(false); window.setMenuBarVisibility(false) }
    contents.setZoomLevel(this.options.zoomLevel())
    // Chromium's own zoom (Ctrl+wheel, a pinch) changes one window: every window takes it, so they stay alike.
    contents.on('zoom-changed', () => setImmediate(() => {
      if (window.isDestroyed()) return
      const level = contents.getZoomLevel()
      this.options.setZoomLevel(level)
      this.zoom(level)
    }))
    window.on('closed', () => {
      this.windows.delete(window.id)
      this.options.changed(this.windows.size)
    })
    this.options.changed(this.windows.size)
  }
  /** The focused popout, if one is focused, with its own record of the user's input. */
  focused(): { window: W; activation: UserActivation } | undefined { return [...this.windows.values()].find(item => !item.window.isDestroyed() && item.window.isFocused()) }
  /**
   * Brings the popout the page opened as `name` to the top, restoring it if minimized, without activating it: keyboard focus
   * stays where the user is (Search Objects' Reveal, from its hits, into a popped-out Object Explorer). False when there is none.
   */
  raise(name: string): boolean {
    const item = [...this.windows.values()].find(value => value.name === name && !value.window.isDestroyed())
    if (!item) return false
    if (item.window.isMinimized()) item.window.showInactive()
    item.window.moveTop()
    return true
  }
  /** Every popout follows the main window's zoom. */
  zoom(level: number): void { for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.webContents.setZoomLevel(level) }
  get size(): number { return this.windows.size }
  /** The page that owns them is going (reload, crash, close): its popouts go at once, without asking. */
  closeAll(): void {
    for (const { window } of [...this.windows.values()]) if (!window.isDestroyed()) window.destroy()
    this.windows.clear()
    this.pending = []
  }
}
