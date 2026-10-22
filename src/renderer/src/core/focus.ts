import type { DocumentService } from '../services/documents'
import { modalOpen } from './modal'

/** Where focus was before a menu or the quick input took it, and how to return there; the DOM version is `domFocusAdapter`. */
export interface FocusAdapter { capture(): unknown; restore(target: unknown): void }

/** Transient surfaces that take focus only while open: focus is never returned to them. */
const transient = '.quick-input, .menu-layer, .title-bar-menus'

/**
 * Returns focus to the element that had it before the quick input or a menu opened, so the chosen command (Undo, Find,
 * Cut) acts on it. When that element is gone, cannot take focus (hidden with its query), or is inside a dialog that is
 * no longer the open one, the active document (the query editor, or a table designer) gets focus instead, unless a dialog is open. With no query either, a menubar
 * button or menu item gives focus up: once the menus have closed, nothing acts on its keys.
 */
export function domFocusAdapter(documents: Pick<DocumentService, 'getSnapshot' | 'focusActive'>): FocusAdapter {
  return {
    capture: () => {
      const element = document.activeElement
      return element instanceof HTMLElement && element !== document.body && !element.closest(transient) ? element : undefined
    },
    restore: target => {
      if (target instanceof HTMLElement && target !== document.body && target.isConnected) {
        const modal = target.closest('[aria-modal="true"]'), open = [...document.querySelectorAll('[aria-modal="true"]')].at(-1)
        if (modal ? modal === open : !open) {
          target.focus({ preventScroll: true })
          if (document.activeElement === target) return
        }
      }
      // The active document: the query editor, or a table designer's grid.
      if (!modalOpen() && documents.getSnapshot().documents.length) { documents.focusActive(); return }
      const element = document.activeElement
      if (element instanceof HTMLElement && element.closest('.menu-layer, .title-bar-menus')) element.blur()
    }
  }
}
