import { appIndexUrl } from './app-protocol'

/** Whether a sender URL is the workbench page: exactly `app://varia/index.html` in a built app (no query or fragment,
 *  never a `file:` URL), or any page of the development server's origin. */
export function rendererUrlVerifier(developmentUrl?: string): (senderUrl: string) => boolean {
  return senderUrl => {
    try {
      if (developmentUrl) return new URL(senderUrl).origin === new URL(developmentUrl).origin
      return senderUrl === appIndexUrl
    } catch { return false }
  }
}
