import type { Disposable } from './types'

/**
 * The workbench's windows: the main window and the popout windows its panels moved into (docs/popout-windows.md). Every
 * popout is the page's own same-origin child, so its content is this page's DOM and code; what differs per window is the
 * document focus is in, and the observers and frames that only that window's rendering drives.
 */
export class WindowRegistry {
  private readonly windows = new Set<Window>()
  private last: Window | undefined
  private readonly adoptions = new Set<() => void>()
  constructor(readonly main: Window | undefined) {
    if (main) this.add(main)
  }
  /** Tracks focus and input in `target`; the returned disposable forgets it. */
  add(target: Window): Disposable {
    this.windows.add(target)
    // Input as well as focus: a click on something that takes no focus still says which window the user is in.
    const used = () => { this.last = target }
    const events = ['focus', 'pointerdown', 'keydown'] as const
    for (const event of events) target.addEventListener(event, used, true)
    return { dispose: () => {
      for (const event of events) target.removeEventListener(event, used, true)
      this.windows.delete(target)
      if (this.last === target) this.last = undefined
    } }
  }
  /**
   * The window the user is working in: of the windows with focus, the one used last (a test driver can give every window
   * focus at once), else any focused popout; with none focused (a native dialog, another application), the window used
   * last; else the main window.
   */
  active(): Window | undefined {
    const last = this.last && this.windows.has(this.last) && !this.last.closed ? this.last : undefined
    const focused = this.all().filter(target => (target === this.main ? mainDocument() : target.document)?.hasFocus())
    if (last && focused.includes(last)) return last
    return focused.find(target => target !== this.main) ?? (focused.length ? this.main : last ?? this.main)
  }
  /** The active window's document; the main window's is this page's own `document`, since the page's code runs there. */
  activeDocument(): Document | undefined {
    const target = this.active()
    return target && target !== this.main ? target.document : mainDocument()
  }
  /** The focused element of the window the user is in (`document.activeElement` there). */
  activeElement(): Element | null { return this.activeDocument()?.activeElement ?? null }
  /** Whether `target` is one of the workbench's windows, still open. */
  has(target: Window | null | undefined): boolean { return !!target && this.windows.has(target) && !target.closed }
  all(): Window[] { return [...this.windows].filter(target => !target.closed) }
  /** Content moved between windows: observers bound to the old window's rendering bind to the new one. */
  adopted(): void { for (const listener of [...this.adoptions]) listener() }
  onDidAdopt(listener: () => void): Disposable {
    this.adoptions.add(listener)
    return { dispose: () => { this.adoptions.delete(listener) } }
  }
}

export const windows = new WindowRegistry(typeof window === 'undefined' ? undefined : window)

/** The window `node` is in now (it moves when its panel pops out or docks back). */
export function windowOf(node: Node): Window & typeof globalThis {
  return (node.ownerDocument?.defaultView ?? window) as Window & typeof globalThis
}

/**
 * A ResizeObserver from the window `element` is in. A window's observers see only what its own rendering lays out, so
 * one made by the main window never fires for an element in a popout; this one is made again in the element's window
 * whenever content moves between windows, and reports once after each move.
 */
export function observeResize(element: Element, callback: () => void): Disposable {
  let owner: Window | undefined, observer: ResizeObserver | undefined
  const bind = () => {
    const target = windowOf(element)
    if (target === owner && observer) return
    observer?.disconnect()
    owner = target
    if (typeof target.ResizeObserver !== 'function') return
    observer = new target.ResizeObserver(() => callback())
    observer.observe(element)
  }
  bind()
  const adoption = windows.onDidAdopt(() => { const moved = owner !== undefined && owner !== windowOf(element); bind(); if (moved) callback() })
  return { dispose: () => { adoption.dispose(); observer?.disconnect(); observer = undefined } }
}

/** The same for an IntersectionObserver with the window's viewport as its root. */
export function observeIntersection(element: Element, callback: (entries: IntersectionObserverEntry[]) => void): Disposable {
  let owner: Window | undefined, observer: IntersectionObserver | undefined
  const bind = () => {
    const target = windowOf(element)
    if (target === owner && observer) return
    observer?.disconnect()
    owner = target
    if (typeof target.IntersectionObserver !== 'function') return
    observer = new target.IntersectionObserver(entries => callback(entries))
    observer.observe(element)
  }
  bind()
  const adoption = windows.onDidAdopt(bind)
  return { dispose: () => { adoption.dispose(); observer?.disconnect(); observer = undefined } }
}

/** The main window's document: this page's own, wherever its content is shown. */
export function mainDocument(): Document | undefined { return typeof document === 'undefined' ? undefined : document }
