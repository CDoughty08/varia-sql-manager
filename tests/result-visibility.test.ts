import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, BackendState } from '../src/shared/contracts'
import { limits } from '../src/shared/ipc/wire/protocol'
import { WindowRegistry } from '../src/renderer/src/core/windows'
import { ResultVisibilityService } from '../src/renderer/src/results/ResultVisibilityService'

type Records = { target: Element; contentRect: { width: number; height: number } }[]

/** A window with its own ResizeObserver (records are delivered by `resize`) and a document whose visibility can change. */
function fakeWindow() {
  const observers = new Set<{ callback: (records: Records) => void; observed: Set<Element> }>()
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) }
  }
  const target = {
    closed: false,
    document: doc,
    addEventListener: () => {},
    removeEventListener: () => {},
    ResizeObserver: class {
      private readonly entry: { callback: (records: Records) => void; observed: Set<Element> }
      constructor(callback: (records: Records) => void) { this.entry = { callback, observed: new Set() }; observers.add(this.entry) }
      observe(element: Element) { this.entry.observed.add(element) }
      unobserve(element: Element) { this.entry.observed.delete(element) }
      disconnect() { this.entry.observed.clear(); observers.delete(this.entry) }
    }
  }
  return {
    window: target as unknown as Window,
    /** One frame's records: each observer gets those of its elements, in one callback. */
    resize(...elements: FakeElement[]) {
      for (const observer of observers) {
        const records = elements.filter(element => observer.observed.has(element as unknown as Element))
          .map(element => ({ target: element as unknown as Element, contentRect: { width: element.clientWidth, height: element.clientHeight } }))
        if (records.length) observer.callback(records)
      }
    },
    setVisibility(state: DocumentVisibilityState) { doc.visibilityState = state; for (const listener of [...listeners]) listener() },
    observed: () => [...observers].reduce((count, observer) => count + observer.observed.size, 0),
    observers: () => observers.size,
    listeners: () => listeners.size,
    close() { target.closed = true }
  }
}
type FakeWindow = ReturnType<typeof fakeWindow>
interface FakeElement { isConnected: boolean; clientWidth: number; clientHeight: number; ownerDocument: { defaultView: Window } }
const grid = (owner: FakeWindow, width = 400, height = 200): FakeElement => ({ isConnected: true, clientWidth: width, clientHeight: height, ownerDocument: { defaultView: owner.window } })
const hide = (element: FakeElement) => { element.clientWidth = 0; element.clientHeight = 0 }
const show = (element: FakeElement) => { element.clientWidth = 400; element.clientHeight = 200 }
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

function harness(o: { answer?: (visible: number[]) => Promise<ApiResult<unknown>> } = {}) {
  const main = fakeWindow()
  const registry = new WindowRegistry(main.window)
  let generation = 1, mainHidden = false
  const generationListeners = new Set<(generation: number) => void>(), stateListeners = new Set<(state: BackendState) => void>(), pageListeners = new Set<() => void>()
  const send = vi.fn(o.answer ?? (async (visible: number[]) => ({ ok: true as const, value: { visible: visible.length } })))
  const service = new ResultVisibilityService({
    send, generation: () => generation, windows: registry, mainWindow: main.window,
    onGeneration: listener => { generationListeners.add(listener); return { dispose: () => { generationListeners.delete(listener) } } },
    onBackendState: listener => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } },
    mainPage: { hidden: () => mainHidden, subscribe: listener => { pageListeners.add(listener); return () => { pageListeners.delete(listener) } } }
  })
  const track = (resultId: number, element: FakeElement, resultGeneration = generation) => service.track({ generation: resultGeneration, resultId }, element as unknown as Element)
  return {
    main, registry, service, send, track,
    sent: () => send.mock.calls.map(call => call[0]),
    setMainHidden(value: boolean) { mainHidden = value; for (const listener of [...pageListeners]) listener() },
    /** A new backend: the port's generation first, then main's ready state (either may come first). */
    restart(next: number) { generation = next; for (const listener of [...generationListeners]) listener(next); for (const listener of [...stateListeners]) listener({ status: 'ready', generation: next, pid: 1, runtime: 'test', platform: 'test' }) },
    ready(next: number) { for (const listener of [...stateListeners]) listener({ status: 'ready', generation: next, pid: 1, runtime: 'test', platform: 'test' }) },
    listeners: () => generationListeners.size + stateListeners.size + pageListeners.size
  }
}

describe('ResultVisibilityService', () => {
  it('sends the shown set once per change: a query tab switch unmounts one grid and mounts the other as one message', async () => {
    const h = harness()
    const first = grid(h.main), second = grid(h.main)
    const a = h.track(1, first)
    await settle()
    expect(h.sent()).toEqual([[1]])
    // The switch: one grid goes and the other mounts in the same task.
    a.dispose()
    const b = h.track(2, second)
    await settle()
    expect(h.sent()).toEqual([[1], [2]])
    // A grid mounted again for the same result (a sort's swap, a transposed rebuild) changes nothing.
    b.dispose()
    h.track(2, second)
    await settle()
    expect(h.sent()).toEqual([[1], [2]])
  })

  it('counts a grid without a size as hidden: a hidden or collapsed Results panel, a background dock tab; one frame is one message', async () => {
    const h = harness()
    const first = grid(h.main), second = grid(h.main), unsized = grid(h.main, 0, 0)
    h.track(3, first); h.track(1, second); h.track(9, unsized)
    await settle()
    expect(h.sent()).toEqual([[1, 3]])
    // Ctrl+R hides the panel: both grids lose their size in the same frame.
    hide(first); hide(second)
    h.main.resize(first, second)
    await settle()
    expect(h.sent()).toEqual([[1, 3], []])
    show(first); show(second)
    h.main.resize(first, second)
    await settle()
    expect(h.sent()).toEqual([[1, 3], [], [1, 3]])
    // A detached element (dockview moved the panel out of the document) has no size either.
    first.isConnected = false
    h.main.resize(first)
    await settle()
    expect(h.sent().at(-1)).toEqual([1])
    // Two grids of one result (a split) name it once.
    h.track(1, grid(h.main))
    await settle()
    expect(h.sent()).toHaveLength(4)
  })

  it('follows grids into popout windows: their own document\'s visibility, closing, and docking back', async () => {
    const h = harness()
    const popout = fakeWindow()
    h.registry.add(popout.window)
    const element = grid(h.main)
    h.track(4, element)
    await settle()
    expect(h.sent()).toEqual([[4]])
    // The panel pops out: its grid now lives in the popout's document and is observed from there.
    element.ownerDocument = { defaultView: popout.window }
    h.registry.adopted()
    expect([h.main.observed(), popout.observed()]).toEqual([0, 1])
    // A minimized main window does not hide a grid in a popout.
    h.setMainHidden(true)
    await settle()
    expect(h.sent()).toEqual([[4]])
    popout.setVisibility('hidden')
    await settle()
    expect(h.sent()).toEqual([[4], []])
    popout.setVisibility('visible')
    await settle()
    expect(h.sent()).toEqual([[4], [], [4]])
    // A popout's frame is one message too, from its own observer.
    hide(element)
    popout.resize(element)
    await settle()
    expect(h.sent().at(-1)).toEqual([])
    show(element)
    popout.resize(element)
    await settle()
    expect(h.sent().at(-1)).toEqual([4])
    // Docked back into the minimized main window: hidden until the main window shows again.
    element.ownerDocument = { defaultView: h.main.window }
    h.registry.adopted()
    await settle()
    expect([h.main.observed(), popout.observed(), popout.observers(), popout.listeners()]).toEqual([1, 0, 0, 0])
    expect(h.sent().at(-1)).toEqual([])
    h.setMainHidden(false)
    await settle()
    expect(h.sent().at(-1)).toEqual([4])
    // A closed popout shows nothing, even before its grid is unmounted.
    element.ownerDocument = { defaultView: popout.window }
    h.registry.adopted()
    popout.close()
    h.main.resize()
    h.setMainHidden(false)
    await settle()
    expect(h.sent().at(-1)).toEqual([])
  })

  it('sends the whole set again after a backend restart, without the lost generation\'s results, and after a refused send', async () => {
    let refuse = false
    const h = harness({ answer: async visible => refuse ? { ok: false, error: 'The SQL backend is restarting.' } : { ok: true, value: { visible: visible.length } } })
    const old = grid(h.main)
    h.track(1, old)
    h.ready(1)
    await settle()
    expect(h.sent()).toEqual([[1]])
    // The backend restarts: the old grid still shows its lost result, which the new backend never had.
    h.restart(2)
    await settle()
    expect(h.sent()).toEqual([[1], []])
    h.track(7, grid(h.main))
    await settle()
    expect(h.sent()).toEqual([[1], [], [7]])
    // The same backend reporting ready again sends nothing new.
    h.ready(2)
    await settle()
    expect(h.sent()).toHaveLength(3)
    // A send refused while the next backend starts goes again once it is ready, unchanged.
    refuse = true
    h.restart(3)
    const fresh = grid(h.main)
    h.track(8, fresh, 3)
    await settle()
    expect(h.sent().at(-1)).toEqual([8])
    refuse = false
    h.ready(4)
    await settle()
    // Generation 4's port has not reported yet, so the set is still generation 3's; the port's report sends it again.
    expect(h.sent().at(-1)).toEqual([8])
    const before = h.sent().length
    h.restart(4)
    await settle()
    expect(h.sent()).toHaveLength(before + 1)
    expect(h.sent().at(-1)).toEqual([])
  })

  it('keeps one request in flight and then sends only the latest set', async () => {
    const answers: ((value: ApiResult<unknown>) => void)[] = []
    const h = harness({ answer: () => new Promise(resolve => answers.push(resolve)) })
    const elements = [grid(h.main), grid(h.main), grid(h.main)]
    const first = h.track(1, elements[0])
    await settle()
    h.track(2, elements[1])
    await settle()
    first.dispose()
    h.track(3, elements[2])
    await settle()
    expect(h.sent()).toEqual([[1]])
    answers.shift()!({ ok: true, value: { visible: 1 } })
    await settle()
    expect(h.sent()).toEqual([[1], [2, 3]])
    answers.shift()!({ ok: true, value: { visible: 2 } })
    await settle()
    expect(h.sent()).toHaveLength(2)
  })

  it('defers through queueMicrotask called as Chromium requires, with the global as its receiver', async () => {
    const original = globalThis.queueMicrotask
    // Chromium's queueMicrotask throws Illegal invocation unless called on the global (or with no receiver).
    globalThis.queueMicrotask = function (this: unknown, callback: VoidFunction) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      original(callback)
    }
    try {
      const main = fakeWindow(), send = vi.fn(async () => ({ ok: true as const, value: {} }))
      const service = new ResultVisibilityService({ send, generation: () => 1, windows: new WindowRegistry(main.window), mainWindow: main.window,
        onGeneration: () => ({ dispose: () => {} }), onBackendState: () => () => {}, mainPage: { hidden: () => false, subscribe: () => () => {} } })
      service.track({ generation: 1, resultId: 6 }, grid(main) as unknown as Element)
      await settle()
      expect(send.mock.calls).toEqual([[[6]]])
      service.dispose()
    } finally { globalThis.queueMicrotask = original }
  })

  it('bounds the set and lets go of every observer and listener when disposed', async () => {
    const h = harness()
    const many = Array.from({ length: limits.visibility.maxResults + 3 }, (_, at) => h.track(at + 1, grid(h.main)))
    await settle()
    expect(h.sent()[0]).toHaveLength(limits.visibility.maxResults)
    for (const tracked of many.slice(1)) tracked.dispose()
    await settle()
    expect(h.sent().at(-1)).toEqual([1])
    expect(h.main.observed()).toBe(1)
    many[0].dispose()
    expect([h.main.observed(), h.main.observers()]).toEqual([0, 0])
    h.track(5, grid(h.main))
    h.service.dispose()
    await settle()
    expect([h.main.observers(), h.listeners()]).toEqual([0, 0])
    expect(h.sent().at(-1)).toEqual([1])
  })
})
