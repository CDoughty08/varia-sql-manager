import type { DocumentService } from '../services/documents'
import type { FocusAdapter } from './QuickInputService'

/**
 * Returns focus to the element that had it before the quick input opened, so a command picked in the palette (Undo,
 * Find) acts on it. When that element is gone or behind a modal, the query editor gets focus instead.
 */
export function domFocusAdapter(documents: Pick<DocumentService, 'getSnapshot' | 'boundEditor'>): FocusAdapter {
  return {
    capture: () => {
      const element = document.activeElement
      return element instanceof HTMLElement && !element.closest('.quick-input') ? element : undefined
    },
    restore: target => {
      if (target instanceof HTMLElement && target !== document.body && target.isConnected && !target.closest('[aria-modal="true"]')) {
        target.focus({ preventScroll: true })
        return
      }
      if (documents.getSnapshot().documents.length) documents.boundEditor?.focus()
    }
  }
}
