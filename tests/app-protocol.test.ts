import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { appIndexUrl, appMimeTypes, appProtocolHandler, appSchemePrivileges, resolveAppPath } from '../src/main/app-protocol'
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
    const handler = appProtocolHandler(root, policy, async path => { reads.push(path); if (path.endsWith('missing.js')) throw new Error('ENOENT'); return new TextEncoder().encode('x') })
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

  it('is a standard, secure origin that cannot bypass the CSP or register service workers', () => {
    expect(appSchemePrivileges).toMatchObject({ standard: true, secure: true, bypassCSP: false, allowServiceWorkers: false })
    expect(appMimeTypes['.js']).toMatch(/^text\/javascript/)
  })
})
