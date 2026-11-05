import { describe, expect, it } from 'vitest'
import { requestFrame, watchModals, WindowRegistry } from '../src/renderer/src/core/windows'

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

describe('watchModals', () => {
  it('calls back when a dialog opens, and looks for one only when elements come or go outside the editor', () => {
    let callback: (records: unknown[]) => void = () => {}
    let modal = false, queries = 0, opened = 0
    class Observer { constructor(listener: (records: unknown[]) => void) { callback = listener } observe() {} disconnect() {} }
    const doc = { body: {}, defaultView: { MutationObserver: Observer }, querySelector: () => { queries++; return modal ? {} : null } }
    const watch = watchModals(doc as unknown as Document, () => { opened++ })
    const element = { nodeType: 1 }, text = { nodeType: 3 }
    const editor = { closest: (selector: string) => selector.includes('.monaco-editor') ? {} : null }, pane = { closest: () => null }
    queries = 0
    callback([{ type: 'childList', target: editor, addedNodes: [element], removedNodes: [] }, { type: 'childList', target: pane, addedNodes: [text], removedNodes: [] }])
    expect(queries).toBe(0)
    modal = true
    callback([{ type: 'childList', target: pane, addedNodes: [element], removedNodes: [] }])
    expect([queries, opened]).toEqual([1, 1])
    callback([{ type: 'attributes', target: pane, addedNodes: [], removedNodes: [] }])
    expect([queries, opened]).toEqual([2, 1])
    modal = false
    callback([{ type: 'childList', target: pane, addedNodes: [], removedNodes: [element] }])
    modal = true
    callback([{ type: 'attributes', target: pane, addedNodes: [], removedNodes: [] }])
    expect(opened).toBe(2)
    watch.dispose()
  })
})
