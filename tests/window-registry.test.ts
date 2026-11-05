import { describe, expect, it } from 'vitest'
import { requestFrame, WindowRegistry } from '../src/renderer/src/core/windows'

function fakeWindow() {
  const listeners = new Set<() => void>()
  let focused = false
  const target = {
    closed: false,
    document: { hasFocus: () => focused, activeElement: null },
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) }
  }
  return { window: target as unknown as Window, focus(value: boolean) { focused = value; if (value) for (const listener of listeners) listener() }, close() { target.closed = true } }
}

describe('WindowRegistry', () => {
  it('answers the window the user works in: a focused popout, the popout focused last while the main window has no focus, else main', () => {
    const main = fakeWindow(), popout = fakeWindow(), other = fakeWindow()
    const registry = new WindowRegistry(main.window)
    const forget = registry.add(popout.window)
    registry.add(other.window)
    expect(registry.active()).toBe(main.window)
    popout.focus(true)
    expect(registry.active()).toBe(popout.window)
    expect(registry.activeDocument()).toBe(popout.window.document)
    // The OS took focus away (a native dialog, another app): popout keys and menus still belong to it.
    popout.focus(false)
    expect(registry.active()).toBe(popout.window)
    other.focus(true)
    expect(registry.active()).toBe(other.window)
    other.focus(false)
    other.close()
    expect(registry.active()).toBe(main.window)
    expect(registry.all()).toEqual([main.window, popout.window])
    popout.focus(true); popout.focus(false)
    forget.dispose()
    expect([registry.active(), registry.has(popout.window)]).toEqual([main.window, false])
  })
  it('tells observers when content moves between windows', () => {
    const registry = new WindowRegistry(undefined)
    let moves = 0
    const listener = registry.onDidAdopt(() => moves++)
    registry.adopted()
    listener.dispose()
    registry.adopted()
    expect(moves).toBe(1)
  })
  it('runs a frame callback once, on whichever window draws first', () => {
    const frames = new Map<object, (() => void)[]>(), cancelled: number[] = []
    const framed = () => {
      const target = fakeWindow().window as unknown as Record<string, unknown>
      const queue: (() => void)[] = []
      frames.set(target, queue)
      target.requestAnimationFrame = (callback: () => void) => queue.push(callback)
      target.cancelAnimationFrame = (handle: number) => { cancelled.push(handle) }
      return target as unknown as Window
    }
    // A minimized main window draws no frames; the popout does.
    const main = framed(), popout = framed()
    const registry = new WindowRegistry(main)
    registry.add(popout)
    let runs = 0
    requestFrame(() => runs++, registry)
    frames.get(popout)![0]()
    // The other windows' requests are cancelled (the one that ran has nothing left to cancel).
    expect([runs, cancelled.length]).toEqual([1, 2])
    frames.get(main)![0]()
    expect(runs).toBe(1)
  })
})
