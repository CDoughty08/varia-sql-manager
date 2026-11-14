import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, BackendState, ResultsVisibilityParams } from '../src/shared/contracts'
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
/** A grid element: `visible` stands for its computed visibility (checkVisibility with visibilityProperty). */
interface FakeElement { isConnected: boolean; clientWidth: number; clientHeight: number; visible: boolean; ownerDocument: { defaultView: Window }; checkVisibility(options?: { visibilityProperty?: boolean }): boolean }
const grid = (owner: FakeWindow, width = 400, height = 200): FakeElement => ({
  isConnected: true, clientWidth: width, clientHeight: height, visible: true, ownerDocument: { defaultView: owner.window },
  checkVisibility(options) { return options?.visibilityProperty ? this.visible : true }
})
const hide = (element: FakeElement) => { element.clientWidth = 0; element.clientHeight = 0 }
const show = (element: FakeElement) => { element.clientWidth = 400; element.clientHeight = 200 }
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const ready = (generation: number): BackendState => ({ status: 'ready', generation, pid: 1, runtime: 'test', platform: 'test' })

function harness(o: { answer?: (params: ResultsVisibilityParams) => Promise<ApiResult<unknown>>; initial?: BackendState } = {}) {
  const main = fakeWindow()
  const registry = new WindowRegistry(main.window)
  let generation = 1, mainHidden = false
  const generationListeners = new Set<(generation: number) => void>(), stateListeners = new Set<(state: BackendState) => void>(), pageListeners = new Set<() => void>(), layoutListeners = new Set<() => void>()
  const send = vi.fn(o.answer ?? (async (params: ResultsVisibilityParams) => ({ ok: true as const, value: { visible: params.visible.length, applied: true } })))
  const frames: (() => void)[] = []
  const service = new ResultVisibilityService({
    send, generation: () => generation, windows: registry, mainWindow: main.window, source: '00000000-0000-4000-8000-000000000001', frame: callback => { frames.push(callback) },
    onGeneration: listener => { generationListeners.add(listener); return { dispose: () => { generationListeners.delete(listener) } } },
    onBackendState: listener => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } },
    onLayout: listener => { layoutListeners.add(listener); return () => { layoutListeners.delete(listener) } },
    ...o.initial ? { backendState: async () => ({ ok: true as const, value: o.initial! }) } : {},
    mainPage: { hidden: () => mainHidden, subscribe: listener => { pageListeners.add(listener); return () => { pageListeners.delete(listener) } } }
  })
  const track = (resultId: number, element: FakeElement, resultGeneration = generation) => service.track({ generation: resultGeneration, resultId }, element as unknown as Element)
  const state = (value: BackendState) => { for (const listener of [...stateListeners]) listener(value) }
  return {
    main, registry, service, send, track, state,
    sent: () => send.mock.calls.map(call => call[0].visible),
    setMainHidden(value: boolean) { mainHidden = value; for (const listener of [...pageListeners]) listener() },
    /** The results port reports a new generation (it may come before or after main's ready state). */
    port(next: number) { generation = next; for (const listener of [...generationListeners]) listener(next) },
    /** PaneService published: a dock tab or a maximized group changed what shows. */
    layout() { for (const listener of [...layoutListeners]) listener() },
    /** The next frame any window draws. */
    drawFrame() { for (const callback of frames.splice(0)) callback() },
    frames: () => frames.length,
    listeners: () => generationListeners.size + stateListeners.size + pageListeners.size + layoutListeners.size
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
    // Each set carries this load's source and a rising number, for the backend's ordering.
    expect(h.send.mock.calls.map(call => [call[0].source, call[0].seq])).toEqual([['00000000-0000-4000-8000-000000000001', 1], ['00000000-0000-4000-8000-000000000001', 2]])
  })

  it('counts a grid without a size as hidden: a hidden or collapsed Results panel; one frame is one message', async () => {
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

  it('counts a grid in a dock tab behind another, or beside a maximized group, as hidden though it keeps its size', async () => {
    const h = harness()
    const element = grid(h.main)
    h.track(5, element)
    await settle()
    expect(h.sent()).toEqual([[5]])
    // The Messages tab is selected in the Results group: dockview hides the Results panel with visibility: hidden at once,
    // which no ResizeObserver reports; PaneService publishes.
    element.visible = false
    h.layout()
    await settle()
    expect(h.sent()).toEqual([[5], []])
    h.drawFrame()
    await settle()
    expect(h.sent()).toHaveLength(2)
    // Results again: PaneService publishes while the panel is still hidden, and dockview clears visibility: hidden in its
    // next frame; the check after that frame sees it.
    h.layout()
    await settle()
    expect(h.sent()).toHaveLength(2)
    element.visible = true
    h.drawFrame()
    await settle()
    expect(h.sent()).toEqual([[5], [], [5]])
    // A pane change that does not touch this grid sends nothing.
    h.layout()
    await settle()
    h.drawFrame()
    await settle()
    expect(h.sent()).toHaveLength(3)
    // Several pane changes before the frame draws share one frame.
    h.layout(); h.layout()
    await settle()
    h.layout()
    await settle()
    expect(h.frames()).toBe(1)
    h.drawFrame()
    await settle()
    // Disposed with a frame still asked for: it does nothing, though the set has changed since.
    h.layout()
    await settle()
    element.visible = false
    h.service.dispose()
    h.drawFrame()
    await settle()
    expect(h.sent()).toHaveLength(3)
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
    // Out again, then the popout closes: its unloading document reports hidden, and the grid counts as hidden even before
    // it is docked back or unmounted.
    element.ownerDocument = { defaultView: popout.window }
    h.registry.adopted()
    await settle()
    expect(h.sent().at(-1)).toEqual([4])
    // The closed window alone (no visibilitychange from it): any later check counts its grid as hidden.
    popout.close()
    h.setMainHidden(false)
    await settle()
    expect(h.sent().at(-1)).toEqual([])
  })

  it('sends the whole set again after a restart, never a lost generation\'s results, whichever of main and the port reports first', async () => {
    const h = harness()
    const old = grid(h.main)
    h.track(1, old)
    h.state(ready(1))
    await settle()
    expect(h.sent()).toEqual([[1]])
    // The backend restarts. While it is not ready nothing is sent (main would hand it to the next backend).
    h.state({ status: 'restarting', generation: 1, retryInMs: 0 })
    h.track(2, grid(h.main))
    await settle()
    expect(h.sent()).toEqual([[1]])
    // Main reports the next backend ready before the results port has its generation: still held, since the set would
    // name generation 1's ids to generation 2, whose ids start again.
    h.state(ready(2))
    await settle()
    expect(h.sent()).toEqual([[1]])
    h.port(2)
    await settle()
    expect(h.sent()).toEqual([[1], []])
    h.track(7, grid(h.main))
    await settle()
    expect(h.sent()).toEqual([[1], [], [7]])
    // The port first, then main: one set, once both agree.
    h.state({ status: 'restarting', generation: 2, retryInMs: 0 })
    h.port(3)
    h.track(8, grid(h.main), 3)
    await settle()
    expect(h.sent()).toHaveLength(3)
    h.state(ready(3))
    await settle()
    expect(h.sent()).toEqual([[1], [], [7], [8]])
  })

  it('reads main\'s backend state at start, so a reload keeps the generation guard before any state is pushed', async () => {
    // Main already reports generation 2 ready; the results port still has generation 1's results.
    const h = harness({ initial: ready(2) })
    h.track(1, grid(h.main))
    await settle()
    expect(h.sent()).toEqual([])
    h.port(2)
    h.track(4, grid(h.main))
    await settle()
    expect(h.sent()).toEqual([[4]])
    // A state pushed before the answer arrives wins over it.
    const late = harness({ initial: { status: 'restarting', generation: 1, retryInMs: 0 } })
    late.state(ready(1))
    late.track(6, grid(late.main))
    await settle()
    expect(late.sent()).toEqual([[6]])
  })

  it('sends again when the backend recovers in the same generation, and after a refused send', async () => {
    let refuse = false
    const h = harness({ answer: async params => refuse ? { ok: false, error: 'The SQL backend did not answer in time.' } : { ok: true, value: { visible: params.visible.length, applied: true } } })
    h.state(ready(1))
    const element = grid(h.main)
    h.track(1, element)
    await settle()
    expect(h.sent()).toEqual([[1]])
    // The backend stalls; the user hides the grid; the set times out.
    h.state({ status: 'unresponsive', generation: 1, silentMs: 15_000 })
    h.state(ready(1))
    refuse = true
    hide(element)
    h.main.resize(element)
    await settle()
    expect(h.sent()).toEqual([[1], []])
    // Nothing is retried on its own (no timers)...
    await settle()
    expect(h.sent()).toHaveLength(2)
    // ...until the backend reports ready again, in the same generation.
    refuse = false
    h.state({ status: 'unresponsive', generation: 1, silentMs: 15_000 })
    await settle()
    expect(h.sent()).toHaveLength(2)
    h.state(ready(1))
    await settle()
    expect(h.sent()).toEqual([[1], [], []])
    // A ready state that changes nothing sends nothing.
    h.state(ready(1))
    await settle()
    expect(h.sent()).toHaveLength(3)
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
    answers.shift()!({ ok: true, value: { visible: 1, applied: true } })
    await settle()
    expect(h.sent()).toEqual([[1], [2, 3]])
    answers.shift()!({ ok: true, value: { visible: 2, applied: true } })
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
      expect(send.mock.calls.map(call => (call as unknown as [ResultsVisibilityParams])[0].visible)).toEqual([[6]])
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

  it('checks a pane change after the main window\'s own frame, where the dock shows the panel, not whichever window draws first', async () => {
    const main = fakeWindow(), popout = fakeWindow()
    const queues = new Map<Window, (() => void)[]>([[main.window, []], [popout.window, []]])
    for (const [target, queue] of queues) (target as unknown as { requestAnimationFrame(callback: () => void): number }).requestAnimationFrame = callback => queue.push(callback)
    const registry = new WindowRegistry(main.window)
    registry.add(popout.window)
    const layoutListeners = new Set<() => void>(), send = vi.fn(async () => ({ ok: true as const, value: {} }))
    const service = new ResultVisibilityService({ send, generation: () => 1, windows: registry, mainWindow: main.window,
      onGeneration: () => ({ dispose: () => {} }), onBackendState: () => () => {}, onLayout: listener => { layoutListeners.add(listener); return () => { layoutListeners.delete(listener) } },
      mainPage: { hidden: () => false, subscribe: () => () => {} } })
    const element = grid(main)
    element.visible = false
    service.track({ generation: 1, resultId: 3 }, element as unknown as Element)
    await settle()
    const sent = () => send.mock.calls.map(call => (call as unknown as [ResultsVisibilityParams])[0].visible)
    expect(sent()).toEqual([[]])
    for (const listener of layoutListeners) listener()
    await settle()
    // The popout draws first: nothing was asked of it.
    expect(queues.get(popout.window)).toHaveLength(0)
    // The main window's frame: dockview's callback (asked for first) un-hides the panel, then the check runs.
    const queue = queues.get(main.window)!
    queue.unshift(() => { element.visible = true })
    for (const callback of queue.splice(0)) callback()
    await settle()
    expect(sent()).toEqual([[], [3]])
    service.dispose()
  })

  it('agrees with the backend on the most ids one set names', () => {
    const source = readFileSync('backend/Varia.Backend/Results/ResultVisibility.cs', 'utf8')
    expect(source).toContain(`public const int MaxResults = ${limits.visibility.maxResults};`)
  })
})
