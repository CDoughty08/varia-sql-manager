import type { ApiResult, BackendState } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { Disposable } from '../core/types'
import { windowOf, windows as registry, type WindowRegistry } from '../core/windows'
import type { PageVisibility } from '../live/LiveService'

/** A stored result a grid shows: the backend generation that holds it and its id there. */
export interface VisibleResult { readonly generation: number; readonly resultId: number }

export interface ResultVisibilityOptions {
  /** results.visibility: the whole visible set, replacing the last. */
  send(visible: number[]): Promise<ApiResult<unknown>>
  /** The results port's generation now; only its results are named. */
  generation(): number
  onGeneration(listener: (generation: number) => void): Disposable
  onBackendState(listener: (state: BackendState) => void): () => void
  /** The main window's visibility: its document's, and main's word while popouts keep the document reporting visible. */
  mainPage: PageVisibility
  /** The window this page's code runs in (the main window); popouts are the others. */
  mainWindow?: Window
  windows?: WindowRegistry
  /** Runs a flush after the current task's changes (a microtask): one message per change set, never a timer. */
  defer?: (callback: () => void) => void
}

interface Tracked { readonly result: VisibleResult; readonly element: Element; owner: Window | undefined; sized: boolean }
interface Watched { readonly observer: ResizeObserver | undefined; readonly stop: () => void; count: number }

/**
 * Tells the backend which results' grids are shown in any window (results.visibility), so a memory policy can treat the
 * ones nobody sees differently (stage 1 of the page compression plan). A grid is shown while its element has a size
 * (a background tab, a hidden or collapsed Results panel, a grid scrolled out of a dock group, and a detached element all
 * have none) and its window is visible (a minimized main window or popout is not). Each window's grids share one
 * ResizeObserver, so a frame's changes arrive together; the changes of one task go as one message of the whole set, only
 * when the set differs from the last one sent, with at most one request in flight. A new backend generation, or a backend
 * that became ready again, gets the whole set again. The backend takes it as a hint: a lost message delays its policy only.
 */
export class ResultVisibilityService implements Disposable {
  private readonly o: ResultVisibilityOptions
  private readonly windows: WindowRegistry
  private readonly defer: (callback: () => void) => void
  private readonly tracked = new Set<Tracked>()
  private readonly byElement = new Map<Element, Tracked>()
  private readonly watched = new Map<Window, Watched>()
  private readonly stops: (() => void)[] = []
  /** The set last sent (sorted ids, joined), or undefined when the backend may not have it. */
  private sent: string | undefined
  private flushing = false
  private inFlight = false
  private again = false
  private readyGeneration: number | undefined
  private disposed = false

  constructor(o: ResultVisibilityOptions) {
    this.o = o
    this.windows = o.windows ?? registry
    // Called unbound: Chromium's queueMicrotask throws Illegal invocation when called as a method of another object.
    this.defer = o.defer ?? (callback => queueMicrotask(callback))
    const generations = o.onGeneration(() => this.resend())
    this.stops.push(() => generations.dispose())
    this.stops.push(o.onBackendState(state => {
      if (state.status !== 'ready' || state.generation === this.readyGeneration) return
      this.readyGeneration = state.generation
      this.resend()
    }))
    this.stops.push(o.mainPage.subscribe(() => this.changed()))
    const adoption = this.windows.onDidAdopt(() => this.rebind())
    this.stops.push(() => adoption.dispose())
  }

  /** The grid `element` shows `result` until the returned disposable runs (the grid's disposal). */
  track(result: VisibleResult, element: Element): Disposable {
    const entry: Tracked = { result, element, owner: undefined, sized: sizedNow(element) }
    this.tracked.add(entry)
    this.byElement.set(element, entry)
    this.bind(entry)
    this.changed()
    return { dispose: () => {
      if (!this.tracked.delete(entry)) return
      if (this.byElement.get(element) === entry) this.byElement.delete(element)
      this.unbind(entry)
      this.changed()
    } }
  }

  /** The result ids shown now, ascending: of the current generation, with a size, in a visible window. */
  visible(): number[] {
    const generation = this.o.generation(), ids = new Set<number>()
    for (const entry of this.tracked) {
      if (entry.result.generation !== generation || !entry.sized || this.windowHidden(entry.owner)) continue
      ids.add(entry.result.resultId)
    }
    // Past the limit only a hint is lost: the rest count as hidden.
    return [...ids].sort((left, right) => left - right).slice(0, wire.visibility.maxResults)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops.splice(0)) stop()
    for (const watched of this.watched.values()) { watched.observer?.disconnect(); watched.stop() }
    this.watched.clear()
    this.tracked.clear()
    this.byElement.clear()
  }

  private windowHidden(owner: Window | undefined): boolean {
    if (!owner || owner === this.o.mainWindow) return this.o.mainPage.hidden()
    return owner.closed || owner.document.visibilityState !== 'visible'
  }

  private resend(): void {
    this.sent = undefined
    this.changed()
  }

  private changed(): void {
    if (this.disposed || this.flushing) return
    this.flushing = true
    this.defer(() => { this.flushing = false; this.flush() })
  }

  private flush(): void {
    if (this.disposed) return
    if (this.inFlight) { this.again = true; return }
    const visible = this.visible(), key = visible.join(',')
    if (key === this.sent) return
    this.sent = key
    this.inFlight = true
    const settle = (ok: boolean) => {
      this.inFlight = false
      // A refused set (no backend yet, or one restarting) goes again with the next change or the next ready backend.
      if (!ok && this.sent === key) this.sent = undefined
      if (this.again) { this.again = false; this.flush() }
    }
    void this.o.send(visible).then(result => settle(result.ok), () => settle(false))
  }

  /** Observes the grid from the window it is in now, sharing that window's observer and visibility watch. */
  private bind(entry: Tracked): void {
    const owner = windowOf(entry.element)
    if (entry.owner === owner) return
    this.unbind(entry)
    entry.owner = owner
    let watched = this.watched.get(owner)
    if (!watched) {
      const observer = typeof owner.ResizeObserver === 'function' ? new owner.ResizeObserver(records => this.resized(records)) : undefined
      // The main window's visibility comes from mainPage; a popout's from its own document.
      const doc = owner === this.o.mainWindow ? undefined : owner.document
      const onVisibility = () => this.changed()
      doc?.addEventListener('visibilitychange', onVisibility)
      watched = { observer, stop: () => doc?.removeEventListener('visibilitychange', onVisibility), count: 0 }
      this.watched.set(owner, watched)
    }
    watched.count++
    watched.observer?.observe(entry.element)
  }

  private unbind(entry: Tracked): void {
    const owner = entry.owner
    if (!owner) return
    entry.owner = undefined
    const watched = this.watched.get(owner)
    if (!watched) return
    watched.observer?.unobserve(entry.element)
    if (--watched.count > 0) return
    watched.observer?.disconnect()
    watched.stop()
    this.watched.delete(owner)
  }

  /** Content moved between windows (a popout opened, docked back or closed): each grid is observed where it is now. */
  private rebind(): void {
    for (const entry of this.tracked) {
      if (entry.owner === windowOf(entry.element)) continue
      this.bind(entry)
      entry.sized = sizedNow(entry.element)
    }
    this.changed()
  }

  private resized(records: readonly ResizeObserverEntry[]): void {
    let moved = false
    for (const record of records) {
      const entry = this.byElement.get(record.target)
      if (!entry) continue
      const sized = record.target.isConnected && record.contentRect.width > 0 && record.contentRect.height > 0
      if (sized !== entry.sized) { entry.sized = sized; moved = true }
    }
    if (moved) this.changed()
  }
}

/** Whether the element has a size now: connected, laid out and not inside anything hidden. */
function sizedNow(element: Element): boolean {
  return element.isConnected && element.clientWidth > 0 && element.clientHeight > 0
}
