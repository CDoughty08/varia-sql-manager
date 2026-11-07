import type { Platform } from '../../../shared/commands/keybindings'
import type { Disposable } from './types'

/** The middle button, as `MouseEvent.button` and `PointerEvent.button` report it. */
const middleButton = 1
const releaseEvents = ['pointerup', 'mouseup'] as const

/**
 * Stops Chromium's middle-click paste of the X11/Wayland PRIMARY selection, so the page reads the clipboard only through
 * the gated Paste role. On Linux, Blink runs PasteGlobalSelection as the default action of a middle-button release that
 * no listener cancelled: the text lands in a text field, Monaco's or a contenteditable, and a `paste` event with readable
 * clipboard data fires wherever the click lands, with no Paste role and no user-activation check in main.
 * Both release events are cancelled in the capture phase: the mouseup, and the pointerup, since where a handler cancels
 * the pointerdown (the title bar's menus, the plan canvas, Dockview's handles) Chromium sends no mouseup at all and still
 * pastes. That leaves auxclick (middle-click to close a tab), Monaco's middle-button column selection (it reads
 * mousedown), middle-drag panning and every listener's own event alone. Other platforms have no PRIMARY selection.
 */
export function blockPrimaryPaste(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, platform: Platform): Disposable {
  if (platform !== 'linux') return { dispose: () => {} }
  const release = (event: Event) => { if ((event as MouseEvent).button === middleButton) event.preventDefault() }
  for (const type of releaseEvents) target.addEventListener(type, release, { capture: true })
  return { dispose: () => { for (const type of releaseEvents) target.removeEventListener(type, release, { capture: true }) } }
}
