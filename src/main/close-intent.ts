/** Why main asked the page to close: the window's close button, or a quit (⌘Q, the app menu, logging out). */
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
