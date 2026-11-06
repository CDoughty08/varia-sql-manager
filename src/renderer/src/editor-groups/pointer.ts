/** What `afterPointer` listens to: the window in the app, any EventTarget in tests. */
type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/**
 * Runs `then` once the pointer is up and Dockview has handled its release (a Shift-drag float follows the pointer until
 * then), or at once when no pointer is held. A release the window never hears (it lost focus mid-press, a native dialog
 * took the press) ends the hold when the window itself blurs, so nothing waits for a later click. An element's blur, which
 * a capture listener on the window hears too (an editor moved as the float starts), leaves the hold alone.
 */
export function afterPointer(target: Target = window, later: (run: () => void) => void = run => { setTimeout(run) }): { held(): boolean; then(run: () => void): void; dispose(): void } {
  let held = false, waiting: (() => void) | undefined
  const down = () => { held = true }
  const up = () => { held = false; const run = waiting; waiting = undefined; if (run) later(run) }
  const blurred = (event: Event) => { if (event.target === target) up() }
  const capture = { capture: true }
  const listeners = [['pointerdown', down], ['pointerup', up], ['pointercancel', up], ['blur', blurred]] as const
  for (const [name, listener] of listeners) target.addEventListener(name, listener, capture)
  return {
    held: () => held,
    then: run => { if (held) waiting = run; else run() },
    dispose: () => { waiting = undefined; for (const [name, listener] of listeners) target.removeEventListener(name, listener, capture) }
  }
}
