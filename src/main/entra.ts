import type { MessageBoxOptions } from 'electron'

/** Help › Clear Entra ID Token Cache's confirmation. SSMS 22's exact wording is not documented; this follows Learn's
 *  advice for the "token-identified principal" login failure after a group or access change. */
export const clearEntraPrompt = {
  type: 'question', title: 'Clear Entra ID Token Cache', message: 'Clear the Microsoft Entra ID token cache?',
  detail: 'Use this when you were recently granted access to a server or added to a Microsoft Entra group and still cannot sign in. '
    + 'The next connection that uses Microsoft Entra ID gets a new token; servers connected with Microsoft Entra MFA must connect again to sign in.',
  buttons: ['Clear', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true
} as const satisfies MessageBoxOptions

/**
 * Asks, then empties the backend's token cache. The tokens live only in the backend's memory, so there is nothing on disk
 * to remove; a backend that cannot be reached fails as a value (and a restarted backend starts with an empty cache).
 * Resolves to false when the user cancels.
 */
export async function clearEntraTokenCache(deps: { confirm(): Promise<boolean>; clear(): Promise<unknown> }): Promise<boolean> {
  if (!await deps.confirm()) return false
  await deps.clear()
  return true
}
