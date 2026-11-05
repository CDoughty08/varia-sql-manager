import type { DocumentService } from '../services/documents'
import { modalOpen, transientSurfaces as transient } from './modal'
import { windows } from './windows'

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
        const modal = target.closest('[aria-modal="true"]'), open = [...document.querySelectorAll('[aria-modal="true"]')].at(-1)
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
