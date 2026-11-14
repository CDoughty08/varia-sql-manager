import { windows } from './windows'

/**
 * A modal dialog owns the keyboard and the workbench behind it: keys, menus, and the palette do not act while one is open.
 * Dialogs open in the main window, and hold every popout window too.
 */
export const modalOpen = (): boolean => typeof document !== 'undefined' && !!document.querySelector('[aria-modal="true"]')

/** Transient surfaces that take focus only while open (the quick input and the menus): closing them gives focus back. */
export const transientSurfaces = '.quick-input, .menu-layer, .title-bar-menus'

/** Focus stays where it is: a modal dialog is open, or the quick input or a menu has focus (moving it would close them). */
export const focusHeld = (): boolean => modalOpen() || (typeof document !== 'undefined' && !!windows.activeElement()?.closest(transientSurfaces))

/**
 * Runs `focus` (a document putting focus in itself) once the document has drawn, on `frame`, unless focus is held then.
 * A throttled frame (a hidden or background window) can come long after the command that opened the document, after the
 * user opened the palette (F1 just after View › Activity Monitor), a menu or a dialog, which keeps focus.
 */
export function focusWhenDrawn(frame: (callback: () => void) => unknown, focus: () => void, options: { preserveUserInput?: boolean } = {}): void {
  const input = windows.inputRevision
  frame(() => { if (!focusHeld() && (!options.preserveUserInput || input === windows.inputRevision)) focus() })
}
