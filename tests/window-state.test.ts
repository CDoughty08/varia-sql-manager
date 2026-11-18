import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grabArea, mainWindowLimits, onWayland, parseWindowStateFile, placeWindow, WindowStateStore, WindowStateTracker, type Rect, type SavedWindowState, type TrackedWindow } from '../src/main/window-state'

// Work areas as Electron reports them (DIPs): a 1080p primary with a taskbar, a 4K monitor at 200 % (1920x1080 DIPs) to its
// left, a portrait 1440p at 150 % above-right, and a laptop panel.
const primary: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const leftHiDpi: Rect = { x: -1920, y: 0, width: 1920, height: 1080 }
const portrait: Rect = { x: 1920, y: -400, width: 960, height: 1707 }
const laptop: Rect = { x: 0, y: 0, width: 1366, height: 728 }
const macPrimary: Rect = { x: 0, y: 25, width: 1512, height: 920 }
const on = (...workAreas: Rect[]) => ({ workAreas, primary: workAreas[0] })
const saved = (x: number, y: number, width = 1440, height = 960, maximized = false): SavedWindowState => ({ x, y, width, height, maximized })
const position = { canPosition: true }

describe('placeWindow', () => {
  it('opens at the default size centred on the primary display when nothing is saved', () => {
    expect(placeWindow(undefined, on(primary, leftHiDpi), position)).toEqual({ bounds: { x: 240, y: 40, width: 1440, height: 960 }, maximized: false, outcome: 'default' })
  })

  it('fits the default size into a small primary display', () => {
    expect(placeWindow(undefined, on(laptop), position).bounds).toEqual({ x: 0, y: 0, width: 1366, height: 728 })
  })

  it('restores a window that is still on its display, including one at negative coordinates on a left-side monitor', () => {
    expect(placeWindow(saved(100, 50), on(primary, leftHiDpi), position)).toEqual({ bounds: { x: 100, y: 50, width: 1440, height: 960 }, maximized: false, outcome: 'restored' })
    expect(placeWindow(saved(-1800, 20), on(primary, leftHiDpi), position)).toEqual({ bounds: { x: -1800, y: 20, width: 1440, height: 960 }, maximized: false, outcome: 'restored' })
  })

  it('keeps a window that spans two displays while its title bar is on one', () => {
    expect(placeWindow(saved(-700, 30), on(primary, leftHiDpi), position).outcome).toBe('restored')
  })

  it('restores a window on a display above the primary (negative y)', () => {
    expect(placeWindow(saved(1950, -300, 960, 1200), on(primary, portrait), position).outcome).toBe('restored')
  })

  it('moves a window whose monitor was disconnected onto the nearest display, centred', () => {
    expect(placeWindow(saved(-1800, 20), on(primary), position)).toEqual({ bounds: { x: 240, y: 40, width: 1440, height: 960 }, maximized: false, outcome: 'moved' })
    // A monitor that was far to the right: the nearest remaining display is the right-most one.
    expect(placeWindow(saved(5000, 100, 1200, 800), on(primary, leftHiDpi), position)).toEqual({ bounds: { x: 360, y: 120, width: 1200, height: 800 }, maximized: false, outcome: 'moved' })
  })

  it('moves a window whose display layout changed so only a sliver of the title bar remains on screen', () => {
    // Saved at x = 1800 on a wide display; the display now has 1366 DIPs (a lower resolution or a higher scale factor).
    expect(placeWindow(saved(1300, 100, 1200, 700), on(laptop), position)).toEqual({ bounds: { x: 83, y: 14, width: 1200, height: 700 }, maximized: false, outcome: 'moved' })
  })

  it('shrinks a window larger than its display after a scale change, keeping it inside the work area', () => {
    // A 1920x1040 window on what is now a 1366x728 DIP panel (the same panel at a larger scale factor).
    expect(placeWindow(saved(10, 10, 1920, 1040), on(laptop), position)).toEqual({ bounds: { x: 0, y: 0, width: 1366, height: 728 }, maximized: false, outcome: 'resized' })
    expect(placeWindow(saved(300, 200, 1440, 960), on(laptop), position)).toEqual({ bounds: { x: 0, y: 0, width: 1366, height: 728 }, maximized: false, outcome: 'resized' })
  })

  it('grows a window smaller than the minimum to the minimum, within the work area', () => {
    expect(placeWindow(saved(100, 100, 200, 150), on(primary), position)).toEqual({ bounds: { x: 100, y: 100, width: mainWindowLimits.minWidth, height: mainWindowLimits.minHeight }, maximized: false, outcome: 'resized' })
  })

  it('shrinks a huge window to its display', () => {
    expect(placeWindow(saved(0, 0, 90_000, 90_000), on(primary, leftHiDpi), position).bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })

  it('moves a window whose title bar is above the work area (under the macOS menu bar or off the top)', () => {
    expect(placeWindow(saved(100, 0, 1200, 800), on(macPrimary), position).outcome).toBe('moved')
    expect(placeWindow(saved(100, -500, 1200, 800), on(primary), position).outcome).toBe('moved')
  })

  it('moves a window whose title bar is below the bottom of the work area', () => {
    expect(placeWindow(saved(100, 1030, 1200, 800), on(primary), position).outcome).toBe('moved')
  })

  it('handles mixed scale factors: a window on the 200 % monitor is checked in DIPs like any other', () => {
    const placed = placeWindow(saved(-1910, 5, 1900, 1070), on(primary, leftHiDpi), position)
    expect(placed).toEqual({ bounds: { x: -1910, y: 5, width: 1900, height: 1070 }, maximized: false, outcome: 'restored' })
  })

  it('keeps the maximized flag with the normal bounds, even when those move', () => {
    expect(placeWindow(saved(-1800, 20, 1440, 960, true), on(primary), position)).toMatchObject({ maximized: true, outcome: 'moved' })
    expect(placeWindow(saved(100, 50, 1440, 960, true), on(primary), position)).toMatchObject({ maximized: true, outcome: 'restored' })
  })

  it('restores only the size where windows cannot place themselves (Wayland)', () => {
    expect(placeWindow(saved(-1800, 20, 1200, 800, true), on(primary), { canPosition: false })).toEqual({ bounds: { width: 1200, height: 800 }, maximized: true, outcome: 'sizeOnly' })
    expect(placeWindow(saved(0, 0, 5000, 100), on(primary, leftHiDpi), { canPosition: false }).bounds).toEqual({ width: 1920, height: 700 })
  })

  it('ignores broken display reports', () => {
    const broken = { x: Number.NaN, y: 0, width: 0, height: 0 }
    expect(placeWindow(saved(100, 50), { workAreas: [broken, primary], primary: broken }, position).outcome).toBe('restored')
    expect(placeWindow(saved(100, 50), { workAreas: [], primary: broken }, position)).toEqual({ bounds: { width: 1440, height: 960 }, maximized: false, outcome: 'sizeOnly' })
    expect(placeWindow(saved(100, 50), { workAreas: [], primary }, position).outcome).toBe('restored')
  })
})

describe('grabArea', () => {
  it('needs a grabbable strip of the top edge on one display', () => {
    expect(grabArea(saved(1920 - 100, 100), [primary])).toBeUndefined()
    expect(grabArea(saved(1920 - 200, 100), [primary])).toEqual(primary)
    expect(grabArea(saved(-1440 + 100, 100), [primary])).toBeUndefined()
  })
})

describe('parseWindowStateFile', () => {
  const file = (main: unknown) => ({ version: 1, main })
  it('accepts a version 1 file and rounds fractions', () => {
    expect(parseWindowStateFile(file({ x: -10.4, y: 20.6, width: 1200, height: 800, maximized: true }))).toEqual({ x: -10, y: 21, width: 1200, height: 800, maximized: true })
  })
  it.each([
    ['missing', undefined],
    ['not an object', 'x'],
    ['another version', { version: 2, main: { x: 0, y: 0, width: 1200, height: 800, maximized: false } }],
    ['extra fields', { version: 1, main: { x: 0, y: 0, width: 1200, height: 800, maximized: false, minimized: true } }],
    ['a string coordinate', file({ x: '0', y: 0, width: 1200, height: 800, maximized: false })],
    ['a zero width', file({ x: 0, y: 0, width: 0, height: 800, maximized: false })],
    ['a negative height', file({ x: 0, y: 0, width: 1200, height: -5, maximized: false })],
    ['a huge coordinate', file({ x: 1e12, y: 0, width: 1200, height: 800, maximized: false })],
    ['a huge size', file({ x: 0, y: 0, width: 1e7, height: 800, maximized: false })],
    ['a missing flag', file({ x: 0, y: 0, width: 1200, height: 800 })],
    ['null', null]
  ])('rejects %s', (_name, value) => { expect(parseWindowStateFile(value)).toBeUndefined() })
})

describe('onWayland', () => {
  const none = { ozonePlatform: '', ozonePlatformHint: '' }
  it('follows the session type under the automatic hint, as Chromium chooses its platform', () => {
    expect(onWayland('win32', none, { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' })).toBe(false)
    expect(onWayland('darwin', none, {})).toBe(false)
    expect(onWayland('linux', none, { DISPLAY: ':0' })).toBe(false)
    expect(onWayland('linux', none, { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' })).toBe(true)
    expect(onWayland('linux', { ozonePlatform: '', ozonePlatformHint: 'auto' }, { XDG_SESSION_TYPE: 'wayland' })).toBe(true)
    // WSLg and X11 desktops that also export a Wayland display stay on X11.
    expect(onWayland('linux', none, { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe(false)
    expect(onWayland('linux', { ozonePlatform: '', ozonePlatformHint: 'auto' }, { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'x11' })).toBe(false)
  })

  it('takes the explicit platform and hint switches', () => {
    expect(onWayland('linux', { ozonePlatform: 'x11', ozonePlatformHint: '' }, { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' })).toBe(false)
    expect(onWayland('linux', { ozonePlatform: '', ozonePlatformHint: 'x11' }, { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' })).toBe(false)
    expect(onWayland('linux', { ozonePlatform: 'wayland', ozonePlatformHint: '' }, {})).toBe(true)
    expect(onWayland('linux', { ozonePlatform: '', ozonePlatformHint: 'wayland' }, { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true)
    expect(onWayland('linux', { ozonePlatform: '', ozonePlatformHint: 'wayland' }, { WAYLAND_SOCKET: '3' })).toBe(true)
    expect(onWayland('linux', { ozonePlatform: '', ozonePlatformHint: 'wayland' }, { XDG_SESSION_TYPE: 'wayland' })).toBe(false)
  })
})

describe('WindowStateStore', () => {
  let folder: string
  afterEach(async () => { if (folder) await rm(folder, { recursive: true, force: true }) })
  const make = async () => { folder = await mkdtemp(join(tmpdir(), 'varia-window-state-')); return join(folder, 'window-state.json') }

  it('reads nothing from a missing file and writes a version 1 file', async () => {
    const path = await make(), store = new WindowStateStore(path)
    expect(await store.load()).toBeUndefined()
    await store.save(saved(-1800, 20, 1440, 960, true))
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, main: { x: -1800, y: 20, width: 1440, height: 960, maximized: true } })
    expect(await new WindowStateStore(path).load()).toEqual(saved(-1800, 20, 1440, 960, true))
  })

  it('quarantines a corrupt file and starts from the default', async () => {
    const path = await make()
    await writeFile(path, '{"version":1,"main":{"x":"left"}}')
    expect(await new WindowStateStore(path).load()).toBeUndefined()
    const names = await readdir(folder)
    expect(names.some(name => name.startsWith('window-state.json.invalid-'))).toBe(true)
    expect(names).not.toContain('window-state.json')
  })

  it('never writes over a path it could not read', async () => {
    const path = await make()
    await mkdir(path)
    const store = new WindowStateStore(path)
    expect(await store.load()).toBeUndefined()
    await store.save(saved(0, 0))
    expect(await readdir(path)).toEqual([])
  })

  it('refuses to write a state that would not read back', async () => {
    const path = await make(), store = new WindowStateStore(path)
    await store.save(saved(Number.NaN, 0))
    await expect(readFile(path)).rejects.toThrow()
  })
})

/** A main window as the tracker sees it, with its events. */
function fakeWindow(bounds: Rect) {
  const listeners = new Map<string, (() => void)[]>()
  const state = { bounds, normal: bounds, maximized: false, minimized: false, fullScreen: false, destroyed: false }
  const emit = (event: string) => { for (const listener of listeners.get(event) ?? []) listener() }
  const window: TrackedWindow = {
    getBounds: () => state.bounds, getNormalBounds: () => state.normal,
    isMaximized: () => state.maximized, isMinimized: () => state.minimized, isFullScreen: () => state.fullScreen, isDestroyed: () => state.destroyed,
    on: (event, listener) => { listeners.set(event, [...listeners.get(event) ?? [], listener]) }
  }
  return { window, state, emit }
}

describe('WindowStateTracker', () => {
  afterEach(() => { vi.useRealTimers() })
  const setup = (platform: NodeJS.Platform = 'win32', initial?: SavedWindowState) => {
    vi.useFakeTimers()
    const save = vi.fn(async (_state: SavedWindowState) => {})
    const tracker = new WindowStateTracker({ platform, save, delayMs: 500 }, initial)
    const fake = fakeWindow({ x: 100, y: 50, width: 1440, height: 960 })
    tracker.track(fake.window)
    return { tracker, save, ...fake }
  }

  it('saves once a move or resize settles, not on every event', async () => {
    const { save, state, emit } = setup()
    for (let x = 101; x < 120; x++) { state.bounds = { ...state.bounds, x }; emit('move'); vi.advanceTimersByTime(100) }
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    await vi.runAllTimersAsync()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenLastCalledWith({ x: 119, y: 50, width: 1440, height: 960, maximized: false })
  })

  it('saves at once on close, and the latest state is what a reopened window starts from', async () => {
    const { tracker, save, state, emit } = setup()
    state.bounds = { x: 10, y: 20, width: 1200, height: 800 }
    emit('resize')
    emit('close')
    await tracker.flush()
    expect(save).toHaveBeenCalledWith({ x: 10, y: 20, width: 1200, height: 800, maximized: false })
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(tracker.current()).toEqual({ x: 10, y: 20, width: 1200, height: 800, maximized: false })
  })

  it('keeps the normal bounds and the flag of a maximized window', async () => {
    const { tracker, save, state, emit } = setup()
    state.maximized = true; state.bounds = { x: -8, y: -8, width: 1936, height: 1056 }
    emit('maximize'); emit('resize')
    emit('close')
    await tracker.flush()
    expect(save).toHaveBeenLastCalledWith({ x: 100, y: 50, width: 1440, height: 960, maximized: true })
  })

  it('never keeps minimized: a window minimized from maximized reopens maximized', async () => {
    const { tracker, save, state, emit } = setup()
    state.maximized = true; emit('maximize')
    state.maximized = false; state.minimized = true; state.bounds = { x: -32000, y: -32000, width: 160, height: 28 }
    emit('move')
    emit('close')
    await tracker.flush()
    expect(save).toHaveBeenLastCalledWith({ x: 100, y: 50, width: 1440, height: 960, maximized: true })
  })

  it('does not keep full screen: the window reopens as it was before', async () => {
    const { tracker, save, state, emit } = setup('darwin')
    state.fullScreen = true; state.bounds = { x: 0, y: 0, width: 1512, height: 982 }; state.normal = state.bounds
    emit('enter-full-screen'); emit('resize')
    emit('close')
    await tracker.flush()
    expect(save).toHaveBeenLastCalledWith({ x: 100, y: 50, width: 1440, height: 960, maximized: false })
  })

  it('uses the last normal bounds it saw on Linux, whose maximized windows report no reliable normal bounds', async () => {
    const { tracker, save, state, emit } = setup('linux')
    state.bounds = { x: 300, y: 200, width: 1300, height: 900 }; emit('move')
    vi.advanceTimersByTime(500)
    state.maximized = true; state.bounds = { x: 0, y: 0, width: 1920, height: 1040 }; state.normal = state.bounds
    emit('maximize'); emit('resize')
    emit('close')
    await tracker.flush()
    expect(save).toHaveBeenLastCalledWith({ x: 300, y: 200, width: 1300, height: 900, maximized: true })
  })

  it('ignores a size reported before the maximized state, as X11 window managers may order them', async () => {
    const { tracker, save, state, emit } = setup('linux')
    // The resize to the work area arrives while isMaximized() is still false; the flag follows within the same burst.
    state.bounds = { x: 0, y: 0, width: 1920, height: 1040 }; emit('resize')
    state.maximized = true; state.normal = state.bounds; emit('maximize')
    vi.advanceTimersByTime(500)
    emit('close')
    await tracker.flush()
    expect(save).toHaveBeenLastCalledWith({ x: 100, y: 50, width: 1440, height: 960, maximized: true })
  })

  it('reopens maximized after a close in full screen entered from maximized, though Windows unmaximizes first', async () => {
    const { tracker, save, state, emit } = setup('win32')
    state.maximized = true; emit('maximize')
    vi.advanceTimersByTime(5000)
    // Windows restores the zoomed window, then marks it full screen.
    state.maximized = false; emit('unmaximize')
    state.fullScreen = true; state.bounds = { x: 0, y: 0, width: 1920, height: 1080 }; emit('enter-full-screen'); emit('resize')
    emit('close')
    await tracker.flush()
    expect(save).toHaveBeenLastCalledWith({ x: 100, y: 50, width: 1440, height: 960, maximized: true })
  })

  it('a real unmaximize long before full screen stays unmaximized', async () => {
    const { tracker, save, state, emit } = setup('win32')
    state.maximized = true; emit('maximize')
    state.maximized = false; emit('unmaximize')
    vi.advanceTimersByTime(5000)
    state.fullScreen = true; state.bounds = { x: 0, y: 0, width: 1920, height: 1080 }; emit('enter-full-screen')
    emit('close')
    await tracker.flush()
    expect(save).toHaveBeenLastCalledWith({ x: 100, y: 50, width: 1440, height: 960, maximized: false })
  })

  it('keeps the pending save of a replacement window when the window it replaced closes', async () => {
    const { tracker, save, emit } = setup('win32')
    const replacement = fakeWindow({ x: 400, y: 300, width: 1200, height: 800 })
    tracker.track(replacement.window)
    replacement.state.maximized = true; replacement.emit('maximize')
    emit('closed')
    vi.advanceTimersByTime(500)
    await tracker.flush()
    expect(save).toHaveBeenLastCalledWith({ x: 400, y: 300, width: 1200, height: 800, maximized: true })
  })

  it('writes nothing when the place did not change', async () => {
    const { tracker, save, emit } = setup('win32', { x: 100, y: 50, width: 1440, height: 960, maximized: false })
    emit('close')
    await tracker.flush()
    expect(save).not.toHaveBeenCalled()
  })

  it('a failed write is not thrown, and flush still settles', async () => {
    vi.useFakeTimers()
    const tracker = new WindowStateTracker({ platform: 'win32', save: () => Promise.reject(new Error('disk full')) })
    const { window, emit } = fakeWindow({ x: 1, y: 2, width: 1100, height: 750 })
    tracker.track(window)
    emit('close')
    await expect(tracker.flush()).resolves.toBeUndefined()
  })
})
