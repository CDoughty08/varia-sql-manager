import type { ApiResult, BackendState, BackendStatus, ResultsVisibilityParams } from '../../../shared/contracts'
import { limits as wire } from '../../../shared/ipc/wire/protocol'
import type { Disposable } from '../core/types'
import { windowOf, windows as registry, type WindowRegistry } from '../core/windows'
import type { PageVisibility } from '../live/LiveService'

/** A stored result a grid shows: the backend generation that holds it and its id there. */
export interface VisibleResult { readonly generation: number; readonly resultId: number }

export interface ResultVisibilityOptions {
  /** results.visibility: the whole visible set, replacing the last. */
  send(params: ResultsVisibilityParams): Promise<ApiResult<unknown>>
  /** The results port's generation now; only its results are named. */
  generation(): number
  onGeneration(listener: (generation: number) => void): Disposable
  onBackendState(listener: (state: BackendState) => void): () => void
  /** Main's backend state now, read once at start: a state pushed before this service subscribed (a reload) would
   *  otherwise leave its generation guard off until the next change. */
  backendState?(): Promise<ApiResult<BackendState>>
  /** Layout changes no ResizeObserver reports: the dock hides an inactive tab, or the panels around a maximized group,
   *  with `visibility: hidden` and leaves its size (PaneService's snapshot). */
  onLayout?(listener: () => void): () => void
  /** This renderer load's id for the backend's ordering of sets; a fresh UUID by default. */
  source?: string
  /** The main window's visibility: its document's, and main's word while popouts keep the document reporting visible. */
  mainPage: PageVisibility
  /** The window this page's code runs in (the main window); popouts are the others. */
  mainWindow?: Window
  windows?: WindowRegistry
  /** Runs a flush after the current task's changes (a microtask): one message per change set, never a timer. */
  defer?: (callback: () => void) => void
  /** Runs a callback once on the dock's next frame: the main window's, where dockview un-hides its panels (another
   *  window's frame may come first). The checks pass their own. */
  frame?: (callback: () => void) => void
}

interface Tracked { readonly result: VisibleResult; readonly element: Element; owner: Window | undefined }
interface Watched { readonly observer: ResizeObserver | undefined; readonly stop: () => void; count: number }

/**
 * Tells the backend which query results' grids are shown in any window (results.visibility), so a memory policy can treat
 * the ones nobody sees differently (stage 1 of the page compression plan). Only query results (ResultGrid: result sets,
 * pivots, comparisons, Peek's rows) are reported; live views' tables are replaced every tick and are not, so a policy
 * must leave live tables alone. A grid is shown while its element is rendered
 * with a size (a query tab not shown has unmounted it; a hidden or collapsed Results panel and a detached element have no
 * size; a dock tab behind another, or a panel beside a maximized group, is `visibility: hidden`) and its window is visible
 * (a minimized main window or popout is not). Each window's grids share one ResizeObserver, and pane changes, window
 * moves and visibility changes trigger the same check; the changes of one task go as one message of the whole set,
 * measured when it is sent, only when the set differs from the last one sent, with at most one request in flight. Once
 * main has reported a state (read at start, then pushed), sets are sent only while it reports the backend ready in the
 * generation the results port has, so a set rarely names a lost
 * generation's results to the next backend (the request carries no generation: one flushed as main restarts the backend,
 * before either event arrives, still reaches the next one, and the whole set sent at its ready replaces it). Each set
 * carries this load's source and a rising number, so the backend ignores one from this load that arrives late; a late set
 * from a previous load (a reload is far slower than a control request) is applied until this load's next set. The
 * backend takes it as a hint: a lost or stale set delays its policy only.
 */
export class ResultVisibilityService implements Disposable {
  private readonly o: ResultVisibilityOptions
  private readonly windows: WindowRegistry
  private readonly defer: (callback: () => void) => void
  private readonly frame: (callback: () => void) => void
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
  /** Main's backend status, once it has reported one; until then the backend is taken as ready. */
  private status: BackendStatus | undefined
  private readonly source: string
  private seq = 0
  /** A frame is asked for after a pane change; more changes before it draws share it. */
  private framePending = false
  private disposed = false

  constructor(o: ResultVisibilityOptions) {
    this.o = o
    this.windows = o.windows ?? registry
    // Called unbound: Chromium's queueMicrotask throws Illegal invocation when called as a method of another object.
    this.defer = o.defer ?? (callback => queueMicrotask(callback))
    // Not requestFrame: a popout's frame may run before the main window's, where the dock shows the panel. A minimized
    // main window draws none, and its grids count as hidden until it shows again, which draws.
    this.frame = o.frame ?? (callback => { (o.mainWindow ?? globalThis).requestAnimationFrame(() => callback()) })
    this.source = o.source ?? crypto.randomUUID()
    const generations = o.onGeneration(() => this.resend())
    this.stops.push(() => generations.dispose())
    this.stops.push(o.onBackendState(state => this.backend(state)))
    // A pushed state wins over this answer, which may be older.
    void o.backendState?.().then(result => { if (result.ok && this.status === undefined && !this.disposed) this.backend(result.value) }, () => {})
    this.stops.push(o.mainPage.subscribe(() => this.changed()))
    if (o.onLayout) this.stops.push(o.onLayout(() => this.laidOut()))
    const adoption = this.windows.onDidAdopt(() => this.rebind())
    this.stops.push(() => adoption.dispose())
  }

  /** The grid `element` shows `result` until the returned disposable runs (the grid's disposal). */
  track(result: VisibleResult, element: Element): Disposable {
    const entry: Tracked = { result, element, owner: undefined }
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

  /** The result ids shown now, ascending: of the current generation, rendered with a size, in a visible window. */
  visible(): number[] {
    const generation = this.o.generation(), ids = new Set<number>()
    for (const entry of this.tracked) {
      if (entry.result.generation !== generation || ids.has(entry.result.resultId) || this.windowHidden(entry.owner) || !shownNow(entry.element)) continue
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

  /** The dock hides a panel at once but shows one again only in its next frame (dockview positions the overlay, then
   *  clears its `visibility: hidden`), so a pane change is checked now and once more in that window's next frame, asked
   *  for after the task's handlers ran so that it comes after the dock's own. */
  private laidOut(): void {
    this.changed()
    if (this.framePending) return
    this.framePending = true
    this.defer(() => {
      if (this.disposed) return
      this.frame(() => { this.framePending = false; this.changed() })
    })
  }

  private backend(state: BackendState): void {
    const was = this.status, before = this.readyGeneration
    this.status = state.status
    if (state.status !== 'ready') return
    this.readyGeneration = state.generation
    // Every return to ready (a restart, or recovery from unresponsive in the same generation, when a set sent meanwhile
    // may have timed out) gets the whole set again.
    if (was !== 'ready' || before !== state.generation) this.resend()
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
    // Held while the backend is not ready, or main and the results port disagree on its generation: the event that ends
    // either (ready, or the port's generation) sends the whole set.
    if (this.status !== undefined && (this.status !== 'ready' || this.readyGeneration !== this.o.generation())) { this.sent = undefined; return }
    const visible = this.visible(), key = visible.join(',')
    if (key === this.sent) return
    this.sent = key
    this.inFlight = true
    const settle = (ok: boolean) => {
      this.inFlight = false
      // A refused set (no backend yet, one restarting, main's request limit, a deadline) goes again with the next change
      // or the next return to ready; nothing retries on its own, since that would need a timer.
      if (!ok && this.sent === key) this.sent = undefined
      if (this.again) { this.again = false; this.flush() }
    }
    void this.o.send({ source: this.source, seq: ++this.seq, visible }).then(result => settle(result.ok), () => settle(false))
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
    }
    this.changed()
  }

  /** A frame's size changes: the set is measured again when it is flushed, so these only say when to look. */
  private resized(records: readonly ResizeObserverEntry[]): void {
    if (records.some(record => this.byElement.has(record.target))) this.changed()
  }
}

/** Whether the element is rendered now: connected, laid out with a size, and neither inside anything `display: none` nor
 *  `visibility: hidden` (the dock's inactive tabs keep their size). Read when a set is flushed, after the task's changes. */
function shownNow(element: Element): boolean {
  if (!element.isConnected || element.clientWidth <= 0 || element.clientHeight <= 0) return false
  return typeof element.checkVisibility !== 'function' || element.checkVisibility({ visibilityProperty: true })
}
