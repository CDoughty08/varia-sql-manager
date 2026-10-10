import type { KeyboardEvent } from 'react'

/**
 * Keeps Tab inside a modal dialog: Tab past its last control goes to the first, and Shift+Tab before the first (or from
 * the dialog itself, focused by a press on its text) to the last.
 */
export function trapFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')].filter(item => item.getClientRects().length)
  const first = items[0], last = items.at(-1)
  if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
