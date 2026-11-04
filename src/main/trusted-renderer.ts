import { realpathSync } from 'node:fs'
import { win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Chromium can load a Windows portable app through an 8.3 path while Electron reports the long path for its ASAR.
 *  Accept only the same archive and exact renderer path after resolving the archive's real filesystem path. */
export function rendererUrlVerifier(rendererFile: string, developmentUrl?: string, platform: NodeJS.Platform = process.platform, realpath: (path: string) => string = realpathSync.native): (senderUrl: string) => boolean {
  const expectedUrl = pathToFileURL(rendererFile).href
  const suffix = '\\out\\renderer\\index.html'
  const expectedPath = win32.normalize(rendererFile)
  const expectedArchive = expectedPath.toLowerCase().endsWith(suffix) ? expectedPath.slice(0, -suffix.length) : ''
  let resolvedUrl: string | undefined
  return senderUrl => {
    try {
      if (developmentUrl) return new URL(senderUrl).origin === new URL(developmentUrl).origin
      if (senderUrl === expectedUrl || senderUrl === resolvedUrl) return true
      if (platform !== 'win32' || !expectedArchive.toLowerCase().endsWith('\\app.asar')) return false
      const url = new URL(senderUrl)
      if (url.protocol !== 'file:' || url.search || url.hash) return false
      const path = win32.normalize(fileURLToPath(url))
      if (!path.toLowerCase().endsWith(suffix)) return false
      const archive = path.slice(0, -suffix.length)
      if (realpath(archive).toLowerCase() !== realpath(expectedArchive).toLowerCase()) return false
      resolvedUrl = senderUrl
      return true
    } catch { return false }
  }
}
