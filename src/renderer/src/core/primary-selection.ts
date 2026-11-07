import type { Platform } from '../../../shared/commands/keybindings'
import type { Disposable } from './types'

/** The middle button, as `MouseEvent.button` reports it, and its bit in `MouseEvent.buttons`. */
const middleButton = 1, middleButtons = 4
/** The events whose middle-button change Blink may follow with a paste: a chorded press or release (another button still held) comes as a pointermove. */
const changeEvents = new Set(['pointerup', 'mouseup', 'pointermove'])
/** Pointer events, and the drag events that end an HTML drag (no pointer events reach the page during one). */
const watched = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'pointermove', 'pointercancel', 'auxclick', 'dragend', 'drop'] as const

/** A window: its own timers keep running while another window is hidden and throttled. */
export type PrimaryPasteTarget = Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout'>

/**
 * Stops Chromium's middle-click paste of the X11/Wayland PRIMARY selection, so the page reads the clipboard only through
 * the gated Paste role. On Linux, Blink runs PasteGlobalSelection as the default action of a middle-button release that
 * no listener cancelled: the text lands in the focused text field (Monaco's included) or contenteditable, and a `paste`
 * event with readable clipboard data fires at the focused element or the body, with no Paste role and no
 * user-activation check in main.
 *
 * Two guards, in the capture phase of each window:
 * - Every middle-button release event is cancelled, the pointerup as well as the mouseup, since where a handler cancels
 *   the pointerdown (the title bar's menus, the plan canvas, Dockview's handles) Chromium sends no mouseup and still
 *   pastes; and so is every pointermove whose `button` is the middle one, which is how a chorded press or release comes
 *   (cancelling a chorded press only skips its focus and selection handling). A plain middle press is left alone.
 * - A `paste` event is cancelled before any other listener sees it while the middle button is held (from its press,
 *   which reaches the window unless a page script detached its target, until a task after an event shows it up) or in the
 *   task of a middle-button release or its auxclick, in case a release reaches Blink without a cancelled event. The
 *   Paste role's paste comes from main, in a task of its own; one chosen while the middle button is still held (Ctrl+V
 *   during a middle-drag) is dropped too.
 * auxclick (middle-click to close a tab), Monaco's middle-button column selection (it reads mousedown), middle-drag
 * panning (its moves carry no button change) and every listener's own event are left alone. Other platforms have no
 * PRIMARY selection.
 */
export function blockPrimaryPaste(target: PrimaryPasteTarget, platform: Platform): Disposable {
  if (platform !== 'linux') return { dispose: () => {} }
  let held = false, presses = 0, releasing = false
  // Blink dispatches a release, its auxclick and its paste in one task: what they mark ends with that task.
  const later = (run: () => void) => { target.setTimeout(run, 0) }
  const pointer = (event: Event) => {
    const { type, button, buttons } = event as MouseEvent
    if (button === middleButton) {
      if (changeEvents.has(type)) event.preventDefault()
      if (buttons & middleButtons) { held = true; presses++ } else if (!releasing) { releasing = true; later(() => { releasing = false }) }
    }
    if (held && !(buttons & middleButtons)) {
      const press = presses
      later(() => { if (presses === press) held = false })
    }
  }
  const paste = (event: Event) => { if (held || releasing) { event.preventDefault(); event.stopImmediatePropagation() } }
  const listeners = [...watched.map(type => [type, pointer] as const), ['paste', paste] as const]
  for (const [type, listener] of listeners) target.addEventListener(type, listener, { capture: true })
  return { dispose: () => { for (const [type, listener] of listeners) target.removeEventListener(type, listener, { capture: true }) } }
}
