import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dialogRequest, onDisplay, popoutRequest, PopoutWindows, scaleBounds, settledNativeTheme, zoomFactor, type OpenDetails, type PopoutWindow, restoreFocusMs } from '../src/main/popout-windows'
import { dialogLimits, dialogWindowKind, dialogWindowKinds, dialogWindowName, popoutWindowName } from '../src/shared/popouts'
import { windowControls } from '../src/shared/theme/metrics'

const name = 'varia-popout-' + crypto.randomUUID()
const request = (overrides: Partial<OpenDetails> = {}): OpenDetails => ({ url: 'about:blank', frameName: name, features: 'left=100,top=80,width=640,height=420', disposition: 'new-window', ...overrides })
const primary = { x: 0, y: 0, width: 1920, height: 1040 }, left = { x: -1600, y: 120, width: 1600, height: 860 }

/** A popout window as main sees it, recording what the registry does to it. */
function fakeWindow(id: number) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const on = (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, [...listeners.get(event) ?? [], listener]) }
  const emit = (event: string, ...args: unknown[]) => { for (const listener of [...listeners.get(event) ?? []]) listener(...args) }
  const off = (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== listener && (item as { original?: unknown }).original !== listener)) }
  let destroyed = false, focused = false, zoom = 0, minimized = false, stubborn = false
  let openHandler: (() => { action: string }) | undefined
  const window = {
    id, isDestroyed: () => destroyed, isFocused: () => focused, destroy: vi.fn(() => { destroyed = true; emit('closed') }),
    isMinimized: () => minimized, showInactive: vi.fn(() => { if (!stubborn) minimized = false }), restore: vi.fn(() => { minimized = false }), moveTop: vi.fn(),
    setMenuBarVisibility: vi.fn(), setAutoHideMenuBar: vi.fn(), on,
    once: (event: string, listener: () => void) => { const wrapped = () => { off(event, wrapped); listener() }; (wrapped as { original?: () => void }).original = listener; on(event, wrapped) },
    removeListener: (event: string, listener: () => void) => off(event, listener),
    webContents: { setWindowOpenHandler: (handler: () => { action: 'deny' }) => { openHandler = handler }, on, setZoomLevel: (level: number) => { zoom = level }, getZoomLevel: () => zoom }
  }
  return { window: window as unknown as PopoutWindow, emit, listening: (event: string) => listeners.get(event)?.length ?? 0, focus: (value: boolean) => { focused = value }, minimize: () => { minimized = true }, stubborn: () => { stubborn = true }, zoom: () => zoom, setZoom: (level: number) => { zoom = level }, openHandler: () => openHandler?.() }
}
function registry(options: { workAreas?: { x: number; y: number; width: number; height: number }[]; zoom?: number; platform?: NodeJS.Platform } = {}) {
  const changed = vi.fn(), setZoomLevel = vi.fn()
  const popouts = new PopoutWindows<PopoutWindow>({ platform: options.platform ?? 'win32', workAreas: () => options.workAreas ?? [primary, left], zoomLevel: () => options.zoom ?? 0, setZoomLevel, changed })
  return { popouts, changed, setZoomLevel }
}
const base = { backgroundColor: '#1e1e1e', show: false }

describe('popout window requests', () => {
  it('are only the page\'s about:blank children with Varia\'s name and exact bounds', () => {
    expect(popoutRequest(request())).toEqual({ x: 100, y: 80, width: 640, height: 420 })
    expect(popoutRequest(request({ features: 'left=-1500,top=200,width=640,height=420' }))).toEqual({ x: -1500, y: 200, width: 640, height: 420 })
    for (const refused of [
      request({ url: 'https://example.com/' }), request({ url: 'file:///C:/varia/out/renderer/index.html' }), request({ url: 'about:blank#x' }), request({ url: 'javascript:alert(1)' }),
      request({ frameName: '' }), request({ frameName: 'varia-popout-1' }), request({ frameName: name + 'x' }), request({ frameName: '_blank' }),
      request({ disposition: 'foreground-tab' }), request({ disposition: 'background-tab' }),
      request({ features: '' }), request({ features: 'left=100,top=80,width=640,height=420,noopener' }), request({ features: 'width=640,height=420,left=100,top=80' }),
      request({ features: 'left=100,top=80,width=100,height=420' }), request({ features: 'left=100,top=80,width=640,height=99999' })
    ]) expect(popoutRequest(refused)).toBeUndefined()
    expect(popoutWindowName.test(name)).toBe(true)
  })
  it('land on a display, with the top edge on it to grab', () => {
    expect(onDisplay({ x: 100, y: 80, width: 640, height: 420 }, [primary])).toBe(true)
    expect(onDisplay({ x: -1500, y: 200, width: 640, height: 420 }, [primary, left])).toBe(true)
    // The monitor it was on is gone.
    expect(onDisplay({ x: -1500, y: 200, width: 640, height: 420 }, [primary])).toBe(false)
    expect(onDisplay({ x: 1900, y: 80, width: 640, height: 420 }, [primary])).toBe(false)
    expect(onDisplay({ x: 100, y: -300, width: 640, height: 420 }, [primary])).toBe(false)
    expect(onDisplay({ x: 100, y: 1030, width: 640, height: 420 }, [primary])).toBe(false)
  })
})

describe('PopoutWindows', () => {
  it('allows a popout with explicit secure preferences: no preload, sandboxed, isolated, no Node', () => {
    const { popouts } = registry()
    const answer = popouts.open(request(), base)
    expect(answer.action).toBe('allow')
    const options = (answer as { overrideBrowserWindowOptions: Record<string, unknown> }).overrideBrowserWindowOptions
    expect(options).toMatchObject({ x: 100, y: 80, width: 640, height: 420, useContentSize: true, show: false, backgroundColor: '#1e1e1e' })
    expect(options.webPreferences).toEqual({ preload: undefined, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, additionalArguments: [], devTools: true })
    expect(Object.hasOwn(options.webPreferences as object, 'preload')).toBe(true)
  })
  it('places CSS pixels in screen DIPs at the zoom, and checks the display there', () => {
    expect(scaleBounds({ x: 100, y: 80, width: 640, height: 420 }, zoomFactor(1))).toEqual({ x: 120, y: 96, width: 768, height: 504 })
    expect(scaleBounds({ x: 10, y: 10, width: 300, height: 200 }, Number.NaN)).toEqual({ x: 10, y: 10, width: 300, height: 200 })
    const zoomed = registry({ zoom: 1 }).popouts.open(request(), base) as { overrideBrowserWindowOptions: Record<string, unknown> }
    expect(zoomed.overrideBrowserWindowOptions).toMatchObject({ x: 120, y: 96, width: 768, height: 504 })
    // On the display at 100 %, but past its right edge once zoomed out of it.
    expect(registry({ workAreas: [primary], zoom: 3 }).popouts.open(request({ features: 'left=1500,top=80,width=640,height=420' }), base)).toEqual({ action: 'deny' })
  })
  it('denies everything else, windows off every display, and more than the limit', () => {
    const { popouts } = registry({ workAreas: [primary] })
    expect(popouts.open(request({ url: 'https://example.com/' }), base)).toEqual({ action: 'deny' })
    expect(popouts.open(request({ features: 'left=-1500,top=200,width=640,height=420' }), base)).toEqual({ action: 'deny' })
    for (let id = 1; id <= 16; id++) popouts.adopt(fakeWindow(id).window)
    expect(popouts.open(request(), base)).toEqual({ action: 'deny' })
  })
  it('counts windows it allowed that Electron has not created yet, until they arrive or a while has passed', () => {
    let now = 0
    const popouts = new PopoutWindows<PopoutWindow>({ platform: 'win32', workAreas: () => [primary], zoomLevel: () => 0, setZoomLevel: vi.fn(), changed: vi.fn(), now: () => now })
    for (let id = 1; id <= 16; id++) expect(popouts.open(request(), base).action).toBe('allow')
    expect(popouts.open(request(), base)).toEqual({ action: 'deny' })
    // Created: still 16.
    for (let id = 1; id <= 16; id++) popouts.adopt(fakeWindow(id).window)
    expect(popouts.open(request(), base)).toEqual({ action: 'deny' })
    popouts.closeAll()
    for (let id = 1; id <= 16; id++) popouts.open(request(), base)
    expect(popouts.open(request(), base)).toEqual({ action: 'deny' })
    // Never created: they stop counting.
    now = 10_000
    expect(popouts.open(request(), base).action).toBe('allow')
  })
  it('adopts a popout: no popups, no navigation, its own input for Paste, the main window\'s zoom, and a hidden menu bar', () => {
    const { popouts, changed } = registry({ zoom: 1.5 })
    const child = fakeWindow(7)
    popouts.adopt(child.window)
    expect(child.openHandler()).toEqual({ action: 'deny' })
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const navigation = { preventDefault: vi.fn() }
      child.emit(event, navigation)
      expect(navigation.preventDefault).toHaveBeenCalled()
    }
    expect(child.zoom()).toBe(1.5)
    expect(child.window.setMenuBarVisibility).toHaveBeenCalledWith(false)
    expect(changed).toHaveBeenLastCalledWith(1)
    // Focus and input belong to the window the user is in.
    expect(popouts.focused()).toBeUndefined()
    child.focus(true)
    const focused = popouts.focused()!
    expect(focused.window).toBe(child.window)
    expect(focused.activation.recent()).toBe(false)
    child.emit('input-event', {}, { type: 'mouseMove' })
    expect(focused.activation.recent()).toBe(false)
    child.emit('input-event', {}, { type: 'mouseDown' })
    expect(focused.activation.recent()).toBe(true)
    popouts.zoom(-1)
    expect(child.zoom()).toBe(-1)
  })
  it('raises a popout by the name the page opened it with, restoring it if minimized, without activating it', () => {
    const { popouts } = registry()
    const child = fakeWindow(3), other = fakeWindow(4), unnamed = fakeWindow(5)
    const otherName = 'varia-popout-' + crypto.randomUUID()
    popouts.adopt(child.window, name); popouts.adopt(other.window, otherName); popouts.adopt(unnamed.window, '_blank')
    expect(popouts.raise(name)).toBe(true)
    expect(child.window.moveTop).toHaveBeenCalledOnce()
    expect(child.window.showInactive).not.toHaveBeenCalled()
    expect(other.window.moveTop).not.toHaveBeenCalled()
    child.minimize()
    expect(popouts.raise(name)).toBe(true)
    expect(child.window.showInactive).toHaveBeenCalledOnce()
    expect(child.window.moveTop).toHaveBeenCalledTimes(2)
    expect(child.window.restore).not.toHaveBeenCalled()
    // Where showInactive leaves it minimized (macOS), it is restored, focus goes back to the window the user was in, and then
    // it goes on top.
    child.stubborn(); child.minimize()
    const order: string[] = []
    vi.mocked(child.window.moveTop).mockImplementation(() => { order.push('top') })
    vi.mocked(child.window.restore).mockImplementation(() => { order.push('restore') })
    vi.useFakeTimers()
    try {
      expect(popouts.raise(name, () => order.push('refocus'))).toBe(true)
      expect(order).toEqual(['restore', 'refocus', 'top'])
      // The restore activates it later (macOS animates it up): focus goes back then, once, and it stays on top.
      child.emit('focus')
      expect(order).toEqual(['restore', 'refocus', 'top', 'refocus', 'top'])
      child.emit('focus')
      expect(order).toHaveLength(5)
      // A popout that never takes focus stops listening after restoreFocusMs, so a later click into it keeps its focus.
      child.minimize()
      popouts.raise(name, () => order.push('refocus'))
      expect(child.listening('focus')).toBe(1)
      vi.advanceTimersByTime(restoreFocusMs)
      expect(child.listening('focus')).toBe(0)
    } finally { vi.useRealTimers() }
    // A name it does not hold (one that is not a popout's is never stored), or a window that is gone, raises nothing.
    expect(popouts.raise('_blank')).toBe(false)
    expect(popouts.raise('varia-popout-' + crypto.randomUUID())).toBe(false)
    child.window.destroy()
    expect(popouts.raise(name)).toBe(false)
  })
  it('gives every window the zoom Chromium set on one (Ctrl+wheel, a pinch)', async () => {
    const { popouts, setZoomLevel } = registry()
    const first = fakeWindow(1), second = fakeWindow(2)
    popouts.adopt(first.window); popouts.adopt(second.window)
    first.setZoom(2)
    first.emit('zoom-changed')
    await new Promise(resolve => setImmediate(resolve))
    expect(setZoomLevel).toHaveBeenCalledWith(2)
    expect(second.zoom()).toBe(2)
  })
  it('closes every popout with the page that opened them, and reports when none is left', () => {
    const { popouts, changed } = registry({ platform: 'darwin' })
    const first = fakeWindow(1), second = fakeWindow(2)
    popouts.adopt(first.window); popouts.adopt(second.window)
    expect(first.window.setMenuBarVisibility).not.toHaveBeenCalled()
    first.emit('closed')
    expect([popouts.size, changed.mock.lastCall]).toEqual([1, [1]])
    popouts.closeAll()
    expect(second.window.destroy).toHaveBeenCalled()
    expect([popouts.size, changed.mock.lastCall]).toEqual([0, [0]])
  })
})

describe('main process wiring', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  it('lets the page open only popouts, never navigates, and ends popouts with the page', () => {
    expect(source).toContain('contents.setWindowOpenHandler(details => popouts.open(details,')
    expect(source).toContain("contents.on('did-create-window', (child, details) => popouts.adopt(child, details.frameName))")
    // The page raises only its own popouts, by a name that must be a popout's, through the trusted handler.
    expect(source).toContain("const name = z.string().regex(popoutWindowName).parse(value), main = mainWindow")
    expect(source).toContain("popouts.raise(name, () => { if (main && !main.isDestroyed() && !main.isFocused()) main.focus() })")
    expect(source).not.toMatch(/setWindowOpenHandler\([^)]*action: 'allow'/)
    expect(source).toMatch(/function resetRendererState[\s\S]*?popouts\.closeAll\(\)/)
    expect(source).toContain("contents.on('zoom-changed', () => setImmediate(() => { if (!contents.isDestroyed()) popouts.zoom(contents.getZoomLevel()) }))")

    // Popouts turn background throttling off, so the page hears from main when its window is minimized or hidden.
    expect(source).toContain("contents.send('varia:window-hidden', window.isMinimized() || !window.isVisible())")
    expect(source).toContain("window.on('minimize', sendHidden); window.on('restore', sendHidden); window.on('hide', sendHidden); window.on('show', sendHidden)")
  })
  it('keeps trusting only the main window\'s main frame: popouts have no preload and send no IPC', () => {
    expect(source).toContain('if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false')
  })
})

describe('dialog windows', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const dialogName = (kind = 'options') => `varia-dialog-${kind}-${crypto.randomUUID()}`
  const dialog = (overrides: Partial<OpenDetails> = {}): OpenDetails => request({ frameName: dialogName(), features: 'left=200,top=100,width=940,height=680', ...overrides })
  const allowed = (answer: ReturnType<PopoutWindows<PopoutWindow>['open']>) => {
    expect(answer.action).toBe('allow')
    return (answer as { overrideBrowserWindowOptions: Record<string, unknown> }).overrideBrowserWindowOptions
  }
  it('are only about:blank children named for a dialog kind, with exact bounds at least the kind\'s minimum', () => {
    expect(dialogRequest(dialog())).toEqual({ kind: 'options', bounds: { x: 200, y: 100, width: 940, height: 680 } })
    expect(dialogRequest(dialog({ frameName: dialogName('about'), features: 'left=0,top=0,width=520,height=460' }))?.kind).toBe('about')
    for (const refused of [
      dialog({ frameName: dialogName('connect') }), dialog({ frameName: 'varia-dialog-options-1' }), dialog({ frameName: name }), dialog({ url: 'https://example.com/' }),
      dialog({ disposition: 'foreground-tab' }), dialog({ features: 'left=200,top=100,width=300,height=680' }), dialog({ features: 'left=200,top=100,width=940,height=99999' }),
      dialog({ features: 'width=940,height=680,left=200,top=100' })
    ]) expect(dialogRequest(refused)).toBeUndefined()
    expect(dialogWindowKind(dialogName('about'))).toBe('about')
    expect(dialogWindowName.test(name)).toBe(false)
    // A popout request is never a dialog, and a dialog never a popout.
    expect(popoutRequest(dialog())).toBeUndefined()
  })
  it('open frameless (the traffic lights on macOS), with no minimize or maximize, and the popouts\' secure preferences', () => {
    const windows = allowed(registry().popouts.open(dialog(), base))
    expect(windows).toMatchObject({ x: 200, y: 100, width: 940, height: 680, useContentSize: true, minWidth: dialogWindowKinds.options.minWidth, minHeight: dialogWindowKinds.options.minHeight,
      title: 'Options', resizable: true, minimizable: false, maximizable: false, fullscreenable: false, frame: false })
    // No window-controls overlay: the page draws the close button in the theme's colours.
    expect(windows.titleBarOverlay).toBeUndefined()
    expect(windows.titleBarStyle).toBeUndefined()
    expect(windows.webPreferences).toEqual({ preload: undefined, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, additionalArguments: [], devTools: true })
    const mac = allowed(registry({ platform: 'darwin' }).popouts.open(dialog({ frameName: dialogName('about'), features: 'left=0,top=0,width=520,height=460' }), base))
    expect(mac).toMatchObject({ title: 'About Varia SQL Manager', resizable: false, titleBarStyle: 'hidden', trafficLightPosition: windowControls().trafficLights })
    expect(mac.titleBarOverlay).toBeUndefined()
    expect(mac.frame).toBeUndefined()
    // Off every display: denied, as a popout is.
    expect(registry({ workAreas: [primary] }).popouts.open(dialog({ features: 'left=-1500,top=200,width=940,height=680' }), base)).toEqual({ action: 'deny' })
  })
  it('are kept above the main window and leave the popout limit alone', () => {
    const parent = fakeWindow(1).window, setParentWindow = vi.fn()
    const popouts = new PopoutWindows<PopoutWindow>({ platform: 'win32', workAreas: () => [primary], zoomLevel: () => 0, setZoomLevel: vi.fn(), changed: vi.fn(), parent: () => parent })
    const child = fakeWindow(2), panel = fakeWindow(3)
    Object.assign(child.window, { setParentWindow }); Object.assign(panel.window, { setParentWindow: vi.fn() })
    popouts.adopt(child.window, dialogName())
    popouts.adopt(panel.window, name)
    expect(setParentWindow).toHaveBeenCalledWith(parent)
    expect(panel.window.setParentWindow).not.toHaveBeenCalled()
    // Dialog windows deny popups and navigation like every child.
    expect(child.openHandler()).toEqual({ action: 'deny' })
    for (let id = 10; id < 25; id++) popouts.adopt(fakeWindow(id).window)
    // 16 popouts with the dialog open: the dialog does not take a popout's place.
    expect(popouts.open(request(), base)).toEqual({ action: 'deny' })
    expect(popouts.size).toBe(17)
    popouts.closeAll()
    expect(child.window.destroy).toHaveBeenCalled()
  })
  it('hold theme source changes until a closed child window has been torn down, then apply the newest', () => {
    vi.useFakeTimers()
    try {
      let now = 1000
      const popouts = new PopoutWindows<PopoutWindow>({ platform: 'win32', workAreas: () => [primary], zoomLevel: () => 0, setZoomLevel: vi.fn(), changed: vi.fn(), now: () => now })
      const native = { themeSource: 'dark' as 'dark' | 'light' | 'system', shouldUseDarkColors: true }
      const theme = settledNativeTheme(native, popouts)
      // No window has closed: the change lands at once.
      theme.themeSource = 'light'
      expect(native.themeSource).toBe('light')
      const child = fakeWindow(60)
      popouts.adopt(child.window, dialogName())
      child.emit('closed')
      theme.themeSource = 'dark'
      theme.themeSource = 'system'
      // Reads see the newest mode; Electron's waits until the window is gone.
      expect(theme.themeSource).toBe('system')
      expect(native.themeSource).toBe('light')
      expect(theme.shouldUseDarkColors).toBe(true)
      now += 499
      vi.advanceTimersByTime(499)
      expect(native.themeSource).toBe('light')
      now += 1
      vi.advanceTimersByTime(1)
      expect(native.themeSource).toBe('system')
      expect(theme.themeSource).toBe('system')
    } finally { vi.useRealTimers() }
  })
  it('are bounded: one may open while the last of its kind is still closing, but no more than the limit', () => {
    const popouts = registry().popouts
    for (let id = 0; id < dialogLimits.maxWindows; id++) {
      allowed(popouts.open(dialog(), base))
      popouts.adopt(fakeWindow(40 + id).window, dialogName())
    }
    expect(dialogLimits.maxWindows).toBe(Object.keys(dialogWindowKinds).length * 2)
    expect(popouts.open(dialog(), base)).toEqual({ action: 'deny' })
  })
  it('are wired in main: the page\'s window-open handler and the main window as parent', () => {
    expect(source).toContain("contents.setWindowOpenHandler(details => popouts.open(details, { ...appearance.windowChrome(), show: process.env.VARIA_SMOKE_TEST !== '1' }))")
    expect(source).toContain('parent: () => mainWindow ?? undefined')
    expect(source).not.toContain('popouts.chrome(')
    expect(source).toContain('nativeTheme: settledNativeTheme(nativeTheme, popouts)')
  })
})
