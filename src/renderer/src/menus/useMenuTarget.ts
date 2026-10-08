import { useCallback, useRef, type RefCallback } from 'react'
import { useWorkbench } from '../core/WorkbenchContext'
import type { MenuTarget } from './targets'

/**
 * Gives an element a context menu: the ref callback registers it, and `provider` runs when a menu is asked for, so it
 * always sees the latest render's state. The callback's identity is stable; one callback can serve a list of elements,
 * because the provider receives the element.
 */
export function useMenuTarget<T extends Element>(provider: (element: T) => MenuTarget | null): RefCallback<T> {
  const { menuTargets } = useWorkbench()
  const latest = useRef(provider)
  latest.current = provider
  return useCallback((element: T | null) => { if (element) menuTargets.register(element, registered => latest.current(registered as T)) }, [menuTargets])
}
