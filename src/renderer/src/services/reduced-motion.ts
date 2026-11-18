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
export function followReducedMotion(root: Pick<HTMLElement, 'classList'>, options: ReducedMotionOptions): Disposable {
  const { media } = options
  const update = () => { root.classList.toggle(reducedMotionClass, options.enabled() && media?.matches === true) }
  update()
  const unsubscribe = options.subscribe(update)
  media?.addEventListener('change', update)
  return { dispose: () => { unsubscribe(); media?.removeEventListener('change', update); root.classList.remove(reducedMotionClass) } }
}
