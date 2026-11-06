import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { onDisplay, popoutRequest, PopoutWindows, scaleBounds, zoomFactor, type OpenDetails, type PopoutWindow } from '../src/main/popout-windows'
import { popoutWindowName } from '../src/shared/popouts'

const name = 'varia-popout-' + crypto.randomUUID()
const request = (overrides: Partial<OpenDetails> = {}): OpenDetails => ({ url: 'about:blank', frameName: name, features: 'left=100,top=80,width=640,height=420', disposition: 'new-window', ...overrides })
const primary = { x: 0, y: 0, width: 1920, height: 1040 }, left = { x: -1600, y: 120, width: 1600, height: 860 }

/** A popout window as main sees it, recording what the registry does to it. */
function fakeWindow(id: number) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const on = (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, [...listeners.get(event) ?? [], listener]) }
  const emit = (event: string, ...args: unknown[]) => { for (const listener of listeners.get(event) ?? []) listener(...args) }
  let destroyed = false, focused = false, zoom = 0, minimized = false
  let openHandler: (() => { action: string }) | undefined
  const window = {
    id, isDestroyed: () => destroyed, isFocused: () => focused, destroy: vi.fn(() => { destroyed = true; emit('closed') }),
    isMinimized: () => minimized, showInactive: vi.fn(() => { minimized = false }), moveTop: vi.fn(),
    setMenuBarVisibility: vi.fn(), setAutoHideMenuBar: vi.fn(), on,
    webContents: { setWindowOpenHandler: (handler: () => { action: 'deny' }) => { openHandler = handler }, on, setZoomLevel: (level: number) => { zoom = level }, getZoomLevel: () => zoom }
  }
  return { window: window as unknown as PopoutWindow, emit, focus: (value: boolean) => { focused = value }, minimize: () => { minimized = true }, zoom: () => zoom, setZoom: (level: number) => { zoom = level }, openHandler: () => openHandler?.() }
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
    expect(source).toContain("handle('varia:popout-raise', value => { popouts.raise(z.string().regex(popoutWindowName).parse(value)) })")
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
