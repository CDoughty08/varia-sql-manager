/** The part of an Electron session `refuseDownloads` uses. */
export interface DownloadSession {
  on(event: 'will-download', listener: (event: { preventDefault(): void }) => void): unknown
}

/**
 * Cancels every download in the page's session. Main starts none (updates use `net` in their own session, exports go
 * through the backend to a path from main's save dialog), so any download is the page's: a script, or a click on markup
 * it injected (`<a download>`, a blob URL), would otherwise write a file of its choosing through Chromium's save flow.
 */
export function refuseDownloads(session: DownloadSession): void {
  session.on('will-download', event => event.preventDefault())
}
