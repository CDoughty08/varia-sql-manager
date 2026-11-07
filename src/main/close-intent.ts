/**
 * Why main asked the page to close: the window's close button, or a quit (⌘Q, the app menu, logging out on macOS, or a
 * Windows shutdown, restart or log off, which main hears as the window's query-session-end, never as before-quit).
 */
export type CloseIntent = 'window' | 'quit'

/** A quit asked for while a window close is under way makes the whole close a quit; nothing turns a quit back. */
export const mergeCloseIntent = (current: CloseIntent | undefined, next: CloseIntent): CloseIntent => current === 'quit' ? 'quit' : next

/**
 * What main does once the page has finished closing (every unsaved query saved or discarded). macOS apps keep running
 * when their window closes, so there Close Window closes only the window and a quit quits. Elsewhere the last window's
 * close quits the app anyway, so it quits at once.
 */
export function closeAction(platform: NodeJS.Platform, intent: CloseIntent | undefined): 'closeWindow' | 'quit' {
  return platform === 'darwin' && intent !== 'quit' ? 'closeWindow' : 'quit'
}

/**
 * Whether main holds a Windows session end (query-session-end) while the page closes: Windows then waits, showing that
 * Varia is closing, and goes on once the app has quit or the user chooses to end it anyway. A critical end does not wait
 * for anyone, so holding it would only pretend.
 */
export const holdsSessionEnd = (reasons: readonly string[] | undefined): boolean => !reasons?.includes('critical')
