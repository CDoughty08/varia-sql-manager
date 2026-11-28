/** Where a Shift-press lands: the editor area's root in the app, any EventTarget in tests. */
type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & Pick<Node, 'contains'>

/** Dockview's mark for a press its floating window must not move on (`quasiPreventDefault`); tests pin it to the bundle. */
export const dockviewOwnPress = 'dv-quasiPreventDefault'

export interface ShiftPressHost {
  /** Whether `element` (a strip's empty space) is in a docked group: a floating group's strip keeps Dockview's group drag. */
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
 *
 * Inside a floating group's document, Dockview moves the whole float on any Shift-press, taking the pointer from what was
 * pressed: Shift+click could not extend a selection in a floated query's text or a floated document's grid. Such a press is marked as
 * Dockview's own strip and title bar mark theirs, so the float stays put and the press reaches its target unchanged.
 */
export function plainShiftPress(root: Target, host: ShiftPressHost): { dispose(): void } {
  const press = (event: Event) => {
    const target = event.target
    if (!(event as PointerEvent).shiftKey || !(target instanceof Element) || target.closest('.tab-close, .tab-pin, .tab-rename')) return
    // A document's own press: only the float's move reads the mark, so a docked group's documents are unaffected. Only
    // the editor area's own bodies count, in case it is ever rendered inside another Dockview panel's body.
    const body = target.closest('.dv-content-container')
    if (body && root.contains(body)) { (event as unknown as Record<string, unknown>)[dockviewOwnPress] = true; return }
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
