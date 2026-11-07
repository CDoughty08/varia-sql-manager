import type { Platform } from '../../../shared/commands/keybindings'
import type { Disposable } from './types'

/** The middle button, as `MouseEvent.button` and `PointerEvent.button` report it. */
const middleButton = 1
/** The events that carry a middle-button release: a chorded one (another button still held) comes as a pointermove. */
const releaseEvents = ['pointerup', 'mouseup', 'pointermove'] as const

/**
 * Stops Chromium's middle-click paste of the X11/Wayland PRIMARY selection, so the page reads the clipboard only through
 * the gated Paste role. On Linux, Blink runs PasteGlobalSelection as the default action of a middle-button release that
 * no listener cancelled: the text lands in a text field, Monaco's or a contenteditable, and a `paste` event with readable
 * clipboard data fires wherever the click lands, with no Paste role and no user-activation check in main.
 *
 * Two guards, in the capture phase of each window:
 * - Every event that carries a middle-button release is cancelled. The pointerup as well as the mouseup, since where a
 *   handler cancels the pointerdown (the title bar's menus, the plan canvas, Dockview's handles) Chromium sends no
 *   mouseup and still pastes; and a pointermove whose `button` is the middle one, which is how a chorded release comes.
 * - A `paste` event in the same task as a middle-button release (or its auxclick) is cancelled before any other listener
 *   sees it, in case a release reaches Blink some other way. The Paste role's paste comes from main, in a task of its own.
 * auxclick (middle-click to close a tab), Monaco's middle-button column selection (it reads mousedown), middle-drag
 * panning (its moves carry no button change) and every listener's own event are left alone. Other platforms have no
 * PRIMARY selection.
 */
export function blockPrimaryPaste(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, platform: Platform): Disposable {
  if (platform !== 'linux') return { dispose: () => {} }
  let releasing = false
  // Blink dispatches the release, its auxclick and the paste in one task; the flag ends with that task.
  const note = () => { if (!releasing) { releasing = true; setTimeout(() => { releasing = false }) } }
  const release = (event: Event) => { if ((event as MouseEvent).button === middleButton) { event.preventDefault(); note() } }
  const auxclick = (event: Event) => { if ((event as MouseEvent).button === middleButton) note() }
  const paste = (event: Event) => { if (releasing) { event.preventDefault(); event.stopImmediatePropagation() } }
  const listeners = [...releaseEvents.map(type => [type, release] as const), ['auxclick', auxclick] as const, ['paste', paste] as const]
  for (const [type, listener] of listeners) target.addEventListener(type, listener, { capture: true })
  return { dispose: () => { for (const [type, listener] of listeners) target.removeEventListener(type, listener, { capture: true }) } }
}
