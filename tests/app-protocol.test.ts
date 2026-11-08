import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { appIndexUrl, appMimeTypes, appProtocolHandler, appSchemePrivileges, keptBytesLimit, resolveAppPath } from '../src/main/app-protocol'
import { contentSecurityPolicy } from '../src/shared/csp'

const root = resolve('app/out/renderer')

describe('app:// renderer protocol', () => {
  it('resolves the page and its assets under the renderer directory', () => {
    expect(resolveAppPath(root, appIndexUrl)).toBe(join(root, 'index.html'))
    expect(resolveAppPath(root, 'app://varia/')).toBe(join(root, 'index.html'))
    expect(resolveAppPath(root, 'app://varia/assets/index-AbC123.js')).toBe(join(root, 'assets', 'index-AbC123.js'))
    expect(resolveAppPath(root, 'app://varia/assets/results.worker-x.js?v=1#h')).toBe(join(root, 'assets', 'results.worker-x.js'))
    expect(resolveAppPath(root, 'app://varia/assets/codicon-x.ttf')).toBe(join(root, 'assets', 'codicon-x.ttf'))
    expect(resolveAppPath(root, 'app://varia/assets/a%20b.woff2')).toBe(join(root, 'assets', 'a b.woff2'))
  })

  it('keeps dot segments, raw or encoded, inside the renderer directory: the URL parser removes them, as Chromium does', () => {
    for (const url of ['app://varia/../main/index.js', 'app://varia/assets/../../main/index.js', 'app://varia/%2e%2e/main/index.js', 'app://varia/%2E%2E/%2E%2E/main/index.js', 'app://varia/.%2e/main/index.js'])
      expect(resolveAppPath(root, url), url).toBe(join(root, 'main', 'index.js'))
    expect(resolveAppPath(root, 'app://varia/./index.html')).toBe(join(root, 'index.html'))
  })

  it('refuses encoded separators, drive letters, NULs, empty segments and anything outside the renderer directory', () => {
    for (const url of [
      'app://varia/..%2fmain%2findex.js',
      'app://varia/..%5cmain%5cindex.js',
      'app://varia/assets%2f..%2f..%2fmain.js',
      'app://varia/%5c%5cserver%5cshare%5cx.js',
      'app://varia/C:%5cWindows%5cwin.ini',
      'app://varia/c%3a/Windows/win.ini',
      'app://varia//etc/passwd.js',
      'app://varia/assets//x.js',
      'app://varia/index.html%00.js',
      'app://varia/%E0%A4%A.js',
      'app://varia/%2e%2e%2f%2e%2e%2fconnections.json'
    ]) expect(resolveAppPath(root, url), url).toBeUndefined()
  })

  it('refuses other hosts, schemes, credentials, ports and file types', () => {
    for (const url of ['app://other/index.html', 'app://user@varia/index.html', 'app://varia:8080/index.html', 'file:///index.html', 'http://varia/index.html', 'not a url', 'app://varia/notes.txt', 'app://varia/assets/backend.dll', 'app://varia/assets'])
      expect(resolveAppPath(root, url), url).toBeUndefined()
  })

  it('serves files with their type, the page\'s CSP and nosniff, and refuses other methods and missing files', async () => {
    const policy = contentSecurityPolicy()
    const reads: string[] = []
    const handler = appProtocolHandler(root, policy, { read: async path => { reads.push(path); if (path.endsWith('missing.js')) throw new Error('ENOENT'); return new TextEncoder().encode('x') } })
    const script = await handler(new Request('app://varia/assets/results.worker-1.js'))
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(script.headers.get('content-security-policy')).toBe(policy)
    expect(script.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await script.text()).toBe('x')
    expect((await handler(new Request(appIndexUrl))).headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect((await handler(new Request('app://varia/assets/codicon.ttf'))).headers.get('content-type')).toBe('font/ttf')
    expect((await handler(new Request('app://varia/assets/missing.js'))).status).toBe(404)
    reads.length = 0
    expect((await handler(new Request('app://varia/..%2f..%2fmain%2findex.js'))).status).toBe(404)
    expect((await handler(new Request(appIndexUrl, { method: 'POST', body: 'x' }))).status).toBe(405)
    expect(reads).toEqual([])
  })

  /** A handler over an in-memory out/ whose filesystem is case-insensitive, as on Windows and macOS. */
  function rebuildable(keepServed = true) {
    const files = new Map<string, Uint8Array>()
    const reads: string[] = []
    const real = (path: string) => [...files.keys()].find(name => name.toLowerCase() === path.toLowerCase())
    const handler = appProtocolHandler(root, contentSecurityPolicy(), {
      keepServed,
      read: async path => { reads.push(path); const name = real(path); if (!name) throw new Error('ENOENT'); return files.get(name)! },
      canonical: async path => { if (path === root) return root; const name = real(path); if (!name) throw new Error('ENOENT'); return name }
    })
    const text = async (url: string) => { const response = await handler(new Request(url)); return response.status === 200 ? await response.text() : response.status }
    const put = (name: string, value: string | Uint8Array) => files.set(join(root, ...name.split('/')), typeof value === 'string' ? new TextEncoder().encode(value) : value)
    const remove = (name: string) => files.delete(join(root, ...name.split('/')))
    return { handler, text, put, remove, reads }
  }

  it('answers a file a rebuild deleted with the bytes it last served, but always reads the disk first', async () => {
    // A popout window loads the page's style sheet and fonts again; a rebuild of out/ must not leave it unstyled.
    const out = rebuildable()
    out.put('index.html', 'old page')
    out.put('assets/style-1.css', 'body{}')
    expect(await out.text('app://varia/assets/style-1.css')).toBe('body{}')
    expect(await out.text(appIndexUrl)).toBe('old page')
    out.remove('assets/style-1.css')
    out.put('index.html', 'new page')
    const again = await out.handler(new Request('app://varia/assets/style-1.css'))
    expect(again.status).toBe(200)
    expect(again.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await again.text()).toBe('body{}')
    // index.html is never kept: a reload picks up the rebuild, and a deleted page is not served from memory.
    expect(await out.text(appIndexUrl)).toBe('new page')
    out.remove('index.html')
    expect(await out.text(appIndexUrl)).toBe(404)
    // A read torn by a rebuild is replaced by the next good one, not kept.
    out.put('assets/chunk-1.js', 'half')
    expect(await out.text('app://varia/assets/chunk-1.js')).toBe('half')
    out.put('assets/chunk-1.js', 'whole')
    expect(await out.text('app://varia/assets/chunk-1.js')).toBe('whole')
    out.remove('assets/chunk-1.js')
    expect(await out.text('app://varia/assets/chunk-1.js')).toBe('whole')
    // A file never served is still a 404.
    expect(await out.text('app://varia/assets/later.js')).toBe(404)
  })

  it('keeps nothing in packaged builds', async () => {
    const out = rebuildable(false)
    out.put('assets/style-1.css', 'body{}')
    expect(await out.text('app://varia/assets/style-1.css')).toBe('body{}')
    out.remove('assets/style-1.css')
    expect(await out.text('app://varia/assets/style-1.css')).toBe(404)
  })

  it('keeps one copy per file whatever spelling the page asks for, and no more than its limit', async () => {
    // Case variants reach the same file on Windows and macOS: a page script must not make main hold a copy for each.
    const out = rebuildable()
    out.put('assets/start-Ab.js', 'x')
    for (const name of ['start-Ab.js', 'START-AB.JS', 'Start-ab.js']) expect(await out.text('app://varia/assets/' + name)).toBe('x')
    out.remove('assets/start-Ab.js')
    expect(await out.text('app://varia/assets/start-Ab.js')).toBe('x')
    expect(await out.text('app://varia/assets/START-AB.JS')).toBe(404)
    // Past the limit, files are served but not kept.
    out.put('assets/big-1.js', new Uint8Array(keptBytesLimit))
    expect((await out.handler(new Request('app://varia/assets/big-1.js'))).status).toBe(200)
    out.remove('assets/big-1.js')
    expect(await out.text('app://varia/assets/big-1.js')).toBe(404)
    expect(await out.text('app://varia/assets/start-Ab.js')).toBe('x')
  })

  it('is a standard, secure origin that cannot bypass the CSP or register service workers', () => {
    expect(appSchemePrivileges).toMatchObject({ standard: true, secure: true, bypassCSP: false, allowServiceWorkers: false })
    expect(appMimeTypes['.js']).toMatch(/^text\/javascript/)
  })
})
