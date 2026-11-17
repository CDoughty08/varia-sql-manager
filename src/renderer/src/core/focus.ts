import type { DocumentService } from '../services/documents'
import { modalOpen, openModal, transientSurfaces as transient } from './modal'
import { mainDocument, windows } from './windows'

/** Where focus was before a menu or the quick input took it, and how to return there; the DOM version is `domFocusAdapter`. */
export interface FocusAdapter { capture(): unknown; restore(target: unknown): void }

/**
 * Returns focus to the element that had it before the quick input or a menu opened, so the chosen command (Undo, Find,
 * Cut) acts on it. When that element is gone, cannot take focus (hidden with its query), or is inside a dialog that is
 * no longer the open one, the active document (the query editor, or a table designer) gets focus instead, unless a dialog is open. With no query either, a menubar
 * button or menu item gives focus up: once the menus have closed, nothing acts on its keys.
 */
export function domFocusAdapter(documents: Pick<DocumentService, 'getSnapshot' | 'focusActive'>): FocusAdapter {
  return {
    // In the window the user is in: a popout's focused element is in its own document.
    capture: () => {
      const element = windows.activeElement()
      return isElement(element) && element !== element.ownerDocument.body && !element.closest(transient) ? element : undefined
    },
    restore: target => {
      if (isElement(target) && target !== target.ownerDocument.body && target.isConnected) {
        const modal = target.closest('[aria-modal="true"]'), open = openModal()
        if (modal ? modal === open : !open) {
          target.focus({ preventScroll: true })
          if (target.ownerDocument.activeElement === target) return
        }
      }
      // The active document: the query editor, or a table designer's grid.
      if (!modalOpen() && documents.getSnapshot().documents.length) { documents.focusActive(); return }
      const element = windows.activeElement()
      if (isElement(element) && element.closest('.menu-layer, .title-bar-menus')) element.blur()
    }
  }
}

/** An HTML element of any of the workbench's windows: a popout's elements are not the main window's `HTMLElement`s. */
export function isElement(value: unknown): value is HTMLElement {
  if (typeof HTMLElement !== 'undefined' && value instanceof HTMLElement) return true
  return !!value && typeof value === 'object' && (value as Node).nodeType === 1 && typeof (value as HTMLElement).focus === 'function' && typeof (value as HTMLElement).closest === 'function'
}

/** What a dialog gives focus back to when it closes: the focused element of the window the user is in, a popout's when
 *  the dialog opened from one (whether it shows over the main window or in a dialog window of its own). */
export function focusToReturn(registry: Pick<typeof windows, 'activeElement'> = windows): HTMLElement | null {
  const active = registry.activeElement()
  return isElement(active) ? active : null
}
/** Gives focus back to `element` in whichever window holds it, bringing a popout forward again. */
export function returnFocusTo(element: HTMLElement | null | undefined, main: Window | undefined = typeof window === 'undefined' ? undefined : window): void {
  if (!element?.isConnected) return
  const view = element.ownerDocument.defaultView
  if (view && view !== main && !view.closed) view.focus()
  element.focus()
}
const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
/**
 * `returnFocusTo` for a modeless dialog (Options and About in their own windows): another dialog may have opened over the
 * main window meanwhile, and focus behind its backdrop would type into the query beneath it. That dialog takes focus
 * instead; `dialog` is the closing one, still in the page while React removes it. With no element, `otherwise` runs.
 */
export function returnFocusBeside(element: HTMLElement | null | undefined, dialog: Element | null | undefined, otherwise: () => void, main: Window | undefined = typeof window === 'undefined' ? undefined : window): void {
  const own = element?.isConnected ? element.ownerDocument : undefined, top = mainDocument()
  // A dialog over the main window holds every popout too, so the main window's comes before the element's own window.
  const blocking = [top, ...own && own !== top ? [own] : []].flatMap(doc => Array.from(doc?.querySelectorAll?.('[aria-modal="true"]') ?? []).reverse())
    .find(modal => isElement(modal) && modal !== dialog && !dialog?.contains(modal) && !(element && modal.contains(element)))
  if (isElement(blocking)) {
    const view = blocking.ownerDocument.defaultView
    if (view && view !== main && !view.closed) view.focus()
    // Where the user was in it (a document keeps its focused element while another window has the keyboard), else its
    // first field rather than its heading's close button.
    const active = blocking.ownerDocument.activeElement
    const first = Array.from(blocking.querySelectorAll(focusable)).find(item => !item.closest('.connection-heading, .dialog-titlebar')) ?? blocking.querySelector(focusable)
    const target = isElement(active) && active !== blocking && blocking.contains(active) ? active : first
    ;(isElement(target) ? target : blocking).focus()
    return
  }
  if (element?.isConnected) returnFocusTo(element, main)
  else otherwise()
}
/** The first element matching `selector` in any of the workbench's windows: Object Explorer's tree may be in a popout. */
export function findInWindows(selector: string): HTMLElement | null {
  for (const target of windows.all()) {
    const found = (target === windows.main ? mainDocument() : target.document)?.querySelector(selector)
    if (isElement(found)) return found
  }
  return null
}
