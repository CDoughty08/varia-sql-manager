import { realpath } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * The workbench page is served from `app://varia/`, never `file:`: a `file:` page shares its origin with every local
 * file, so its script could `fetch('file:///…')` anything the user can read. On this origin `'self'` is only the built
 * renderer directory, and Chromium refuses `file:` loads from it.
 */
export const appScheme = 'app'
export const appHost = 'varia'
export const appOrigin = `${appScheme}://${appHost}`
export const appIndexUrl = `${appOrigin}/index.html`

/** Standard (relative URLs, an origin of its own) and secure (a secure context: clipboard writes, `crypto.randomUUID`),
 *  with fetch for module scripts and workers; no service workers, no bypassing the CSP. */
export const appSchemePrivileges = { standard: true, secure: true, supportFetchAPI: true, codeCache: true, allowServiceWorkers: false, bypassCSP: false, corsEnabled: false, stream: false } as const

/** Every file type the built renderer holds; anything else is refused rather than guessed. Module scripts and module
 *  workers need a JavaScript type, or Chromium refuses to run them. */
export const appMimeTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

/**
 * The file under `root` an `app://varia/…` URL names, or undefined. Only this host, no credentials or port, and a path
 * whose decoded segments are plain names: no `.` or `..` (raw or percent-encoded), no slashes or backslashes hidden by
 * encoding, no drive letters, no NULs. The joined path must still lie under `root`, and its type must be one the
 * renderer serves.
 */
export function resolveAppPath(root: string, requestUrl: string): string | undefined {
  let url: URL
  try { url = new URL(requestUrl) } catch { return undefined }
  if (url.protocol !== `${appScheme}:` || url.hostname !== appHost || url.port || url.username || url.password) return undefined
  const raw = url.pathname === '/' ? '/index.html' : url.pathname
  if (!raw.startsWith('/')) return undefined
  const segments: string[] = []
  for (const part of raw.slice(1).split('/')) {
    let name: string
    try { name = decodeURIComponent(part) } catch { return undefined }
    if (!name || name === '.' || name === '..' || /[\\/:\0]/.test(name)) return undefined
    segments.push(name)
  }
  const path = join(root, ...segments)
  const inside = relative(root, path)
  if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return undefined
  if (!Object.hasOwn(appMimeTypes, extname(path).toLowerCase())) return undefined
  return path
}

/** At most this many bytes of served files are kept for when the disk no longer has them (the built renderer is about 7 MiB). */
export const keptBytesLimit = 64 * 1024 * 1024

export interface AppProtocolOptions {
  /** Read a file; defaults to the disk. */
  read?: (path: string) => Promise<Uint8Array>
  /** Keep the last good bytes of each served file, for unpackaged builds whose `out/` can be rebuilt under them. */
  keepServed?: boolean
  /** The file's path as the filesystem spells it; defaults to `fs.realpath.native`. */
  canonical?: (path: string) => Promise<string>
}

/**
 * The `protocol.handle` callback: GET and HEAD of files under `root`, with their type, the page's CSP and nosniff.
 * With `keepServed`, a file whose read fails is answered with the bytes last served for it: a rebuild of `out/` under an
 * unpackaged app deletes the old content-hashed files, and a popout window, which loads the page's style sheets and fonts
 * again, or a lazy chunk would otherwise get 404s for what the page is running (a packaged app's asar never changes).
 * Every request still reads the disk first, so a reload picks up a rebuild and a read torn by one is not kept past the
 * next. Bytes are kept only under the file's own spelling (case variants and 8.3 short names reach the same file on
 * Windows and macOS, and must not each hold a copy), and only up to `keptBytesLimit`.
 */
export function appProtocolHandler(root: string, policy: string, options: AppProtocolOptions = {}): (request: Request) => Promise<Response> {
  const read = options.read ?? readFile
  const canonical = options.canonical ?? ((path: string) => new Promise<string>((resolve, reject) => realpath.native(path, (error, real) => error ? reject(error) : resolve(real))))
  const kept = new Map<string, Uint8Array>()
  const index = join(root, 'index.html')
  let keptBytes = 0
  let canonicalRoot: Promise<string> | undefined
  async function keep(path: string, body: Uint8Array) {
    const previous = kept.get(path)
    if (!previous) {
      try {
        canonicalRoot ??= canonical(root)
        const [real, base] = await Promise.all([canonical(path), canonicalRoot])
        if (real !== join(base, relative(root, path))) return
      } catch { return }
    }
    const bytes = keptBytes - (previous?.byteLength ?? 0) + body.byteLength
    if (bytes > keptBytesLimit) return
    kept.set(path, body)
    keptBytes = bytes
  }
  return async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    const path = resolveAppPath(root, request.url)
    if (!path) return new Response(null, { status: 404 })
    let body: Uint8Array | undefined
    try {
      body = await read(path)
      if (options.keepServed && path !== index) await keep(path, body)
    } catch {
      body = kept.get(path)
      if (!body) return new Response(null, { status: 404 })
    }
    const headers = { 'Content-Type': appMimeTypes[extname(path).toLowerCase()], 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' }
    return new Response(request.method === 'HEAD' ? null : body as BodyInit, { status: 200, headers })
  }
}
