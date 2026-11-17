import { windows } from './windows'

/**
 * A modal dialog owns the keyboard and the workbench behind it: keys, menus, and the palette do not act while one is open.
 * A dialog over the main window holds every popout window too. A dialog window (Tools › Options, Help › About) holds only
 * itself: while the user is in it, it owns the keys; in the main window, the workbench works beside it.
 */
export const modalOpen = (): boolean => {
  if (typeof document === 'undefined') return false
  if (document.querySelector('[aria-modal="true"]')) return true
  const active = windows.activeDocument()
  return !!active && active !== document && !!active.querySelector('[aria-modal="true"]')
}

/** The modal dialog the user is in: a dialog window's while the user is in it (one may be open over the main window too), else the top one over the main window. */
export function openModal(): Element | undefined {
  if (typeof document === 'undefined') return undefined
  const active = windows.activeDocument()
  const inWindow = active && active !== document ? [...active.querySelectorAll('[aria-modal="true"]')].at(-1) : undefined
  return inWindow ?? [...document.querySelectorAll('[aria-modal="true"]')].at(-1)
}

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
