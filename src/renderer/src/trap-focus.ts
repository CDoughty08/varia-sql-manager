import type { KeyboardEvent } from 'react'

/**
 * Keeps Tab inside a modal dialog: Tab past its last control goes to the first, and Shift+Tab before the first (or from
 * the dialog itself, focused by a press on its text) to the last.
 */
export function trapFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return
  // Composite widgets (a tree, a grid, a read-only value) take focus through tabindex="0" and are tab stops too.
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter(item => item.getClientRects().length)
  // The dialog's own document: a popout window's is not the main window's.
  const first = items[0], last = items.at(-1), active = event.currentTarget.ownerDocument.activeElement
  if (event.shiftKey && (active === first || active === event.currentTarget)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus() }
}
