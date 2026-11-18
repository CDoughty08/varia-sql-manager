import { reducedMotionClass } from '../../../shared/theme/metrics'
import type { Disposable } from '../core/types'

export const reducedMotionQuery = '(prefers-reduced-motion: reduce)'

export interface ReducedMotionOptions {
  /** Environment › General › Reduce motion when the system asks (`environment.reduceMotionWithSystem`). */
  readonly enabled: () => boolean
  readonly subscribe: (listener: () => void) => () => void
  /** The system's preference; absent where matchMedia is not available, which never reduces motion. */
  readonly media?: SystemMotion
}
/** The part of a MediaQueryList this reads. */
export interface SystemMotion {
  readonly matches: boolean
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}

/**
 * Sets `reducedMotionClass` on the root only while the user follows the system's preference and the system asks for
 * reduced motion, and keeps it current as either changes. Popouts and dialog windows copy the main root's classes
 * (popout-document.ts), so they follow it too. By default the setting is off and every animation plays.
 */
export interface ReducedMotion extends Disposable {
  /**
   * Reads the system's preference again now. Chromium reports a changed media query only when it next renders a frame,
   * which a hidden smoke window may not do; the smoke fixture calls this after each emulateMedia.
   */
  refresh(): void
  /**
   * Also updates when another window of the workbench (a popout or dialog window) sees the preference change: the main
   * window reports it only when it renders a frame, which it does not while minimized, and those windows show its class.
   */
  watch(view: { matchMedia(query: string): SystemMotion }): Disposable
}

export function followReducedMotion(root: Pick<HTMLElement, 'classList'>, options: ReducedMotionOptions): ReducedMotion {
  const { media } = options
  const update = () => { root.classList.toggle(reducedMotionClass, options.enabled() && media?.matches === true) }
  update()
  const unsubscribe = options.subscribe(update)
  media?.addEventListener('change', update)
  return {
    refresh: update,
    watch: view => {
      const other = view.matchMedia(reducedMotionQuery)
      other.addEventListener('change', update)
      return { dispose: () => other.removeEventListener('change', update) }
    },
    dispose: () => { unsubscribe(); media?.removeEventListener('change', update); root.classList.remove(reducedMotionClass) }
  }
}
