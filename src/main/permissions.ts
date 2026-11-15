import type { Session, WebContents } from 'electron'

/** The parts of a `Session` the permission handlers use, so tests can pass a fake. */
export type PermissionSession = Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>

/** The one permission the page has: writing the clipboard (sanitized), from the main window's main frame. */
export function permitted(requester: WebContents | null, main: WebContents | undefined, permission: string, mainFrame: boolean): boolean {
  return !!main && requester === main && mainFrame && permission === 'clipboard-sanitized-write'
}

/**
 * The page may write the clipboard but has no permission to read it: it reads only through the Paste role, which runs
 * within a second of a click or key, and its copies go through main. Every other permission stays denied. Chromium also
 * asks the check handler, without a prompt (`navigator.permissions.query`, device APIs such as WebHID and Web Serial,
 * and before some requests), and Electron's default check grants everything, so checks answer exactly as requests do.
 */
export function installPermissionHandlers(session: PermissionSession, main: () => WebContents | undefined): void {
  session.setPermissionRequestHandler((requester, permission, callback, details) => {
    callback(permitted(requester, main(), permission, 'isMainFrame' in details && details.isMainFrame === true))
  })
  session.setPermissionCheckHandler((requester, permission, _origin, details) => permitted(requester, main(), permission, details.isMainFrame === true))
}
