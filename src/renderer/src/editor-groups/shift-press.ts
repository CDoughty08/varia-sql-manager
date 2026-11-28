/** Where a Shift-press lands: the editor area's root in the app, any EventTarget in tests. */
type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

export interface ShiftPressHost {
  /** Whether `element` (a strip's empty space) is in a docked group: a floating group's strip moves it on a Shift-drag. */
  docked(element: Element): boolean
  /** Shows document `id` in its group, as Dockview's own press on its tab would have. */
  choose(id: string): void
}

/**
 * Dockview floats a query tab as soon as it is pressed with Shift held, and a docked group when its strip's empty space
 * is, so a Shift+click floated tabs by accident. Such a press goes on as a plain click instead: the tab is chosen and
 * nothing floats. A press that moves on is an ordinary drag (the pointer strategy's drag ignores the prevented press), so
 * Float Editor and the usual drags still float. The close and pin buttons and the rename box keep the press, which they
 * take before Dockview hears it.
 */
export function plainShiftPress(root: Target, host: ShiftPressHost): { dispose(): void } {
  const press = (event: Event) => {
    const target = event.target
    if (!(event as PointerEvent).shiftKey || !(target instanceof Element) || target.closest('.tab-close, .tab-pin, .tab-rename')) return
    const tab = target.closest('.dv-tab'), strip = tab ? null : target.closest('.dv-void-container')
    if (!tab && !(strip && host.docked(strip))) return
    // Dockview's Shift float and its activation skip a press that is already prevented.
    event.preventDefault()
    const id = tab?.querySelector('[data-tab-id]')?.getAttribute('data-tab-id')
    if (id && (event as PointerEvent).button === 0) host.choose(id)
  }
  root.addEventListener('pointerdown', press, { capture: true })
  return { dispose: () => root.removeEventListener('pointerdown', press, { capture: true }) }
}
