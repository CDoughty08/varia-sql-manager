import { windows } from '../core/windows'

/**
 * Moves a panel's content (its pane host) into `slot`, in whichever window the slot is: appending adopts it into that
 * document. When it changes windows, observers bound to the old window's rendering bind to the new one.
 */
export function placeHost(host: HTMLElement, slot: HTMLElement): void {
  if (host.parentElement === slot) return
  const before = host.ownerDocument
  slot.append(host)
  if (host.ownerDocument !== before) windows.adopted()
}
