/** What `afterPointer` listens to: the window in the app, any EventTarget in tests. */
type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/**
 * Runs `then` once the pointer is up and Dockview has handled its release (a Shift-drag float follows the pointer until
 * then), or at once when no pointer is held. A release the window never hears (it lost focus mid-press, a native dialog
 * took the press) ends the hold when the window blurs, so nothing waits for a later click.
 */
export function afterPointer(target: Target = window, later: (run: () => void) => void = run => { setTimeout(run) }): { held(): boolean; then(run: () => void): void; dispose(): void } {
  let held = false, waiting: (() => void) | undefined
  const down = () => { held = true }
  const up = () => { held = false; const run = waiting; waiting = undefined; if (run) later(run) }
  const events = ['pointerup', 'pointercancel', 'blur'] as const, capture = { capture: true }
  target.addEventListener('pointerdown', down, capture)
  for (const name of events) target.addEventListener(name, up, capture)
  return {
    held: () => held,
    then: run => { if (held) waiting = run; else run() },
    dispose: () => { waiting = undefined; target.removeEventListener('pointerdown', down, capture); for (const name of events) target.removeEventListener(name, up, capture) }
  }
}
