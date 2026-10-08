import type { Platform } from '../../../shared/commands/keybindings'
import { SnapshotStore } from '../core/store'
import type { Disposable } from '../core/types'

/** The parts of a key event the bare-Alt tracker reads, so tests can pass plain objects. */
export interface AltKeyEvent {
  readonly key: string
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly repeat: boolean
  getModifierState?(key: string): boolean
  preventDefault(): void
}

/**
 * Bare Alt on Windows and Linux: pressing and releasing Alt alone toggles focus on the menubar, as in Windows
 * applications. Any other key, a pointer press, or the window losing focus in between cancels the tap, so Alt+Tab,
 * Alt+click, Alt+drag, AltGr, and Alt shortcuts never count. While Alt is down the menubar shows its access keys.
 * macOS has no in-window menubar, so nothing happens there.
 */
export class MenubarAccess extends SnapshotStore<{ readonly altHeld: boolean }> implements Disposable {
  private armed = false
  constructor(private readonly platform: Platform) { super({ altHeld: false }) }

  noteKeyDown(event: AltKeyEvent): void {
    if (this.platform === 'darwin') return
    if (event.key !== 'Alt' || event.ctrlKey || event.shiftKey || event.metaKey || event.repeat || event.getModifierState?.('AltGraph') === true) {
      this.armed = false
      return
    }
    this.armed = true
    this.setHeld(true)
    // Windows would otherwise treat a tap as entering the window's system menu.
    event.preventDefault()
  }
  /** Whether this release completes a clean tap; the caller decides what the tap does now. */
  noteKeyUp(event: AltKeyEvent): boolean {
    if (this.platform === 'darwin' || event.key !== 'Alt') return false
    this.setHeld(false)
    if (!this.armed) return false
    this.armed = false
    event.preventDefault()
    return true
  }
  /** A pointer press or the window losing focus between press and release. */
  disarm(): void {
    this.armed = false
    this.setHeld(false)
  }
  private setHeld(altHeld: boolean): void { if (this.getSnapshot().altHeld !== altHeld) this.publish({ altHeld }) }
  dispose(): void { this.armed = false; this.clearListeners() }
}

/**
 * Marks the document while the window is inactive, so the title bar can show its inactive colors. It starts active and
 * changes only on focus and blur, so a window the tests never focus keeps the active colors.
 */
export function trackWindowFocus(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, root: { readonly dataset: DOMStringMap }): Disposable {
  root.dataset.windowFocus = 'active'
  const focus = () => { root.dataset.windowFocus = 'active' }, blur = () => { root.dataset.windowFocus = 'inactive' }
  target.addEventListener('focus', focus)
  target.addEventListener('blur', blur)
  return { dispose: () => { target.removeEventListener('focus', focus); target.removeEventListener('blur', blur) } }
}
