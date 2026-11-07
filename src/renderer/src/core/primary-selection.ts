import type { Platform } from '../../../shared/commands/keybindings'
import type { Disposable } from './types'

/** The middle button, as `MouseEvent.button` reports it. */
const middleButton = 1

/**
 * Stops Chromium's middle-click paste of the X11/Wayland PRIMARY selection, so the page reads the clipboard only through
 * the gated Paste role. On Linux, Blink runs PasteGlobalSelection as the default action of a middle-button mouseup that
 * no listener cancelled: the text lands in a text field, Monaco's or a contenteditable, and a `paste` event with readable
 * clipboard data fires wherever the click lands, with no Paste role and no user-activation check in main. Cancelling that
 * mouseup in the capture phase leaves auxclick (middle-click to close a tab), Monaco's middle-button column selection
 * (it reads mousedown) and pointer events alone. Other platforms have no PRIMARY selection.
 */
export function blockPrimaryPaste(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, platform: Platform): Disposable {
  if (platform !== 'linux') return { dispose: () => {} }
  const mouseUp = (event: Event) => { if ((event as MouseEvent).button === middleButton) event.preventDefault() }
  target.addEventListener('mouseup', mouseUp, { capture: true })
  return { dispose: () => target.removeEventListener('mouseup', mouseUp, { capture: true }) }
}
