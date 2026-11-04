import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyUpdateError, httpFailure, UpdateFailure, Updater, type UpdaterOptions, type UpdateSettings } from '../src/main/updater'
import { assetFor, compareVersions, updateLimits, updateManifestSchema, updateStatusText, type UpdateManifest, type UpdateState } from '../src/shared/updates'

const payload = Buffer.from('Varia SQL Manager 1.1.0 installer bytes '.repeat(400))
const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('base64')
const manifest = (version = '1.1.0', bytes = payload): UpdateManifest => ({
  schema: 1, version, assets: [
    { name: `Varia-SQL-Manager-${version}-Windows-x64-Setup.exe`, kind: 'win-setup', arch: 'x64', size: bytes.length, sha512: sha512(bytes) },
    { name: `Varia-SQL-Manager-${version}-Windows-x64-Portable.exe`, kind: 'win-portable', arch: 'x64', size: bytes.length, sha512: sha512(bytes) },
    { name: `Varia-SQL-Manager-${version}-linux-x86_64.AppImage`, kind: 'linux-appimage', arch: 'x64', size: bytes.length, sha512: sha512(bytes) },
    { name: `Varia-SQL-Manager-${version}-mac-arm64.dmg`, kind: 'mac-dmg', arch: 'arm64', size: bytes.length, sha512: sha512(bytes) }
  ]
})

/** setTimeout by hand: `fire(ms)` runs the timers that were set for exactly `ms`. */
function manualTimers() {
  let next = 0
  const pending = new Map<number, { ms: number; callback: () => void }>()
  return {
    pending,
    timers: {
      setTimeout: (callback: () => void, ms: number) => { pending.set(++next, { ms, callback }); return next as unknown as ReturnType<typeof setTimeout> },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => { pending.delete(timer as unknown as number) }
    },
    delays: () => [...pending.values()].map(timer => timer.ms),
    fire(ms: number) {
      for (const [id, timer] of [...pending]) if (timer.ms === ms) { pending.delete(id); timer.callback() }
    }
  }
}

type Answer = Response | Error | ((signal: AbortSignal) => Response)
const chunked = (bytes: Buffer, size = 1000) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (let at = 0; at < bytes.length; at += size) controller.enqueue(new Uint8Array(bytes.subarray(at, at + size)))
    controller.close()
  }
})
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/octet-stream', ...headers } })
const file = (bytes: Buffer, headers: Record<string, string> = {}) => new Response(chunked(bytes), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), ...headers } })

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'varia-updater-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function updater(answers: Record<string, Answer[]>, overrides: Partial<UpdaterOptions> & { settings?: () => UpdateSettings } = {}) {
  const states: UpdateState[] = [], requests: string[] = []
  const timers = manualTimers()
  const instance = new Updater({
    currentVersion: '1.0.0', kind: 'nsis', arch: 'x64', enabled: true,
    feedUrl: 'https://feed.test/varia-update.json', assetUrl: (version, name) => `https://feed.test/download/v${version}/${name}`,
    fetch: async (url, init) => {
      requests.push(url)
      const key = url.endsWith('varia-update.json') ? 'manifest' : 'asset'
      const answer = answers[key]?.shift()
      if (!answer) throw new Error(`No answer for ${url}`)
      if (answer instanceof Error) throw answer
      return typeof answer === 'function' ? answer(init.signal) : answer
    },
    secureOnly: true, downloadDir: join(dir, 'updates'), privateDir: true,
    settings: () => ({ checkAutomatically: true, downloadAutomatically: true }),
    publish: state => states.push(state), now: () => 0, timers: timers.timers,
    ...overrides
  })
  return { instance, states, requests, timers }
}

describe('update versions and manifests', () => {
  it('orders semantic versions, a pre-release before its release', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })
  it('accepts only a strict manifest of release file names', () => {
    expect(updateManifestSchema.safeParse(manifest()).success).toBe(true)
    const bad = (change: (value: UpdateManifest) => unknown) => updateManifestSchema.safeParse(change(structuredClone(manifest()))).success
    expect(bad(value => ({ ...value, extra: 1 }))).toBe(false)
    expect(bad(value => { value.assets[0] = { ...value.assets[0]!, name: '../Varia-SQL-Manager-1.1.0.exe' }; return value })).toBe(false)
    expect(bad(value => { value.assets[0] = { ...value.assets[0]!, name: 'Varia-SQL-Manager-1.1.0/x.exe' }; return value })).toBe(false)
    expect(bad(value => { value.assets[0] = { ...value.assets[0]!, size: updateLimits.assetBytes + 1 }; return value })).toBe(false)
    expect(bad(value => { value.assets[0] = { ...value.assets[0]!, sha512: 'abc' }; return value })).toBe(false)
    expect(bad(value => ({ ...value, version: '1.1' }))).toBe(false)
  })
  it('picks the file for the build\'s kind and architecture', () => {
    const value = manifest()
    expect(assetFor(value, 'nsis', 'x64')?.kind).toBe('win-setup')
    expect(assetFor(value, 'portable', 'x64')?.kind).toBe('win-portable')
    expect(assetFor(value, 'appimage', 'x64')?.kind).toBe('linux-appimage')
    expect(assetFor(value, 'dmg', 'arm64')?.kind).toBe('mac-dmg')
    expect(assetFor(value, 'dmg', 'x64')).toBeUndefined()
    expect(assetFor(value, 'unsupported', 'x64')).toBeUndefined()
  })
  it('says what the status bar shows, and hides what it need not', () => {
    const base = { currentVersion: '1.0.0', kind: 'nsis', enabled: true } as const
    expect(updateStatusText({ ...base, status: 'idle' })).toBeUndefined()
    expect(updateStatusText({ ...base, status: 'upToDate', checkedAt: 0 })).toBeUndefined()
    expect(updateStatusText({ ...base, status: 'checking', manual: false })).toBeUndefined()
    expect(updateStatusText({ ...base, status: 'checking', manual: true })).toBe('Checking for updates…')
    expect(updateStatusText({ ...base, status: 'downloading', version: '1.1.0', received: 50, total: 200 })).toBe('Downloading update 25%')
    expect(updateStatusText({ ...base, status: 'ready', version: '1.1.0' })).toBe('Restart to update to 1.1.0')
    expect(updateStatusText({ ...base, kind: 'dmg', status: 'ready', version: '1.1.0' })).toBe('Update 1.1.0 downloaded')
  })
})

describe('update failures', () => {
  it('names the corporate network failures from Chromium\'s errors', () => {
    const code = (message: string) => classifyUpdateError(new Error(message)).code
    expect(code('net::ERR_TUNNEL_CONNECTION_FAILED')).toBe('proxy')
    expect(code('net::ERR_PROXY_CONNECTION_FAILED')).toBe('proxy')
    expect(code('net::ERR_PROXY_AUTH_UNSUPPORTED')).toBe('proxyAuth')
    expect(code('net::ERR_CERT_AUTHORITY_INVALID')).toBe('tls')
    expect(code('net::ERR_NAME_NOT_RESOLVED')).toBe('dns')
    expect(code('net::ERR_INTERNET_DISCONNECTED')).toBe('offline')
    expect(code('net::ERR_CONNECTION_TIMED_OUT')).toBe('timeout')
    expect(code('net::ERR_BLOCKED_BY_ADMINISTRATOR')).toBe('blocked')
    expect(code('net::ERR_CONNECTION_RESET')).toBe('blocked')
    expect(code('net::ERR_SOMETHING_NEW')).toBe('unknown')
    expect(classifyUpdateError(new TypeError('fetch failed', { cause: new Error('net::ERR_CERT_DATE_INVALID') }))).toEqual({ code: 'tls', detail: 'net::ERR_CERT_DATE_INVALID' })
    expect(classifyUpdateError(Object.assign(new Error('ENOSPC: no space left, write \'C:\\Users\\x\''), { code: 'ENOSPC' }))).toEqual({ code: 'disk', detail: 'ENOSPC' })
    expect(classifyUpdateError(Object.assign(new Error('EACCES'), { code: 'EACCES' })).code).toBe('notWritable')
    // An unknown failure's message (which may hold a path) is not shown, only its name.
    expect(classifyUpdateError(new RangeError('at C:\\Users\\someone'))).toEqual({ code: 'unknown', detail: 'RangeError' })
  })
  it('reads HTTP statuses as a managed network would mean them', () => {
    expect(httpFailure(407, 'manifest').code).toBe('proxyAuth')
    expect(httpFailure(403, 'manifest').code).toBe('blocked')
    expect(httpFailure(451, 'asset').code).toBe('blocked')
    expect(httpFailure(404, 'manifest').code).toBe('notFound')
    expect(httpFailure(404, 'asset').code).toBe('server')
    expect(httpFailure(503, 'asset').code).toBe('server')
    expect(httpFailure(504, 'asset').code).toBe('timeout')
    expect(httpFailure(418, 'asset')).toMatchObject({ code: 'unknown', detail: 'HTTP 418' })
  })
})

describe('Updater', () => {
  it('reports the latest version when the feed has nothing newer', async () => {
    const { instance, states } = updater({ manifest: [json(manifest('1.0.0'))] })
    const state = await instance.check(true)
    expect(state).toMatchObject({ status: 'upToDate', currentVersion: '1.0.0', kind: 'nsis', enabled: true })
    expect(states.map(item => item.status)).toEqual(['checking', 'upToDate'])
  })
  it('downloads with progress, verifies, and keeps only the verified file', async () => {
    // Each reading of the clock is 300 ms later than the last, so every chunk shows progress.
    let now = 0
    const { instance, states, requests } = updater({ manifest: [json(manifest())], asset: [file(payload)] }, { now: () => (now += 300) })
    const state = await instance.check(false)
    expect(state).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(requests).toEqual(['https://feed.test/varia-update.json', 'https://feed.test/download/v1.1.0/Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe'])
    const progress = states.filter(item => item.status === 'downloading')
    expect(progress.length).toBeGreaterThan(2)
    expect(progress[0]).toMatchObject({ received: 0, total: payload.length })
    for (let i = 1; i < progress.length; i++) expect((progress[i] as { received: number }).received).toBeGreaterThan((progress[i - 1] as { received: number }).received)
    const ready = instance.readyFile!
    expect(ready.file).toBe(join(dir, 'updates', 'Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe'))
    expect(await readFile(ready.file)).toEqual(payload)
    expect(await readdir(join(dir, 'updates'))).toEqual(['Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe'])
  })
  it('discards a download whose checksum does not match, and says a proxy may have changed it', async () => {
    const tampered = Buffer.from(payload)
    tampered[10] = 0
    const { instance } = updater({ manifest: [json(manifest())], asset: [file(tampered)] })
    const state = await instance.check(true)
    expect(state).toMatchObject({ status: 'error', code: 'integrity', during: 'download', manual: true, version: '1.1.0', detail: 'SHA-512 mismatch' })
    expect(state.status === 'error' && state.hint).toContain('github.com')
    expect(await readdir(join(dir, 'updates'))).toEqual([])
    expect(instance.readyFile).toBeUndefined()
  })
  it('refuses a download larger or smaller than the release says', async () => {
    const longer = Buffer.concat([payload, Buffer.from('x')])
    const { instance } = updater({ manifest: [json(manifest()), json(manifest())], asset: [new Response(chunked(longer)), new Response(chunked(payload.subarray(1)))] })
    expect(await instance.check(true)).toMatchObject({ code: 'integrity', detail: 'Larger than the release says' })
    expect(await instance.check(true)).toMatchObject({ code: 'integrity', detail: 'Smaller than the release says' })
  })
  it('recognises a filter\'s or captive portal\'s page in place of the manifest or the file', async () => {
    const page = () => new Response('<html>Blocked by policy</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    const { instance } = updater({ manifest: [page(), json({ hello: 'world' }), new Response('not json'), json(manifest())], asset: [page()] })
    expect(await instance.check(false)).toMatchObject({ status: 'error', code: 'invalidFeed', during: 'check', manual: false, detail: 'An HTML page' })
    expect(await instance.check(false)).toMatchObject({ code: 'invalidFeed', detail: 'Not a release manifest' })
    expect(await instance.check(false)).toMatchObject({ code: 'invalidFeed', detail: 'Not JSON' })
    expect(await instance.check(false)).toMatchObject({ code: 'blocked', during: 'download' })
  })
  it('turns proxy and network failures into codes with remedies', async () => {
    const { instance } = updater({ manifest: [new Error('net::ERR_TUNNEL_CONNECTION_FAILED'), new Response('', { status: 407 }), new Response('', { status: 403 })] })
    const proxy = await instance.check(true)
    expect(proxy).toMatchObject({ status: 'error', code: 'proxy', detail: 'net::ERR_TUNNEL_CONNECTION_FAILED' })
    expect(proxy.status === 'error' && proxy.message).toMatch(/proxy/)
    expect(await instance.check(true)).toMatchObject({ code: 'proxyAuth', detail: 'HTTP 407' })
    expect(await instance.check(true)).toMatchObject({ code: 'blocked', detail: 'HTTP 403' })
  })
  it('refuses an answer that a redirect took off https', async () => {
    const answer = json(manifest())
    Object.defineProperty(answer, 'url', { value: 'http://intercept.corp/varia-update.json' })
    const { instance } = updater({ manifest: [answer] })
    expect(await instance.check(true)).toMatchObject({ code: 'blocked', detail: 'Redirected off https' })
  })
  it('refuses a manifest larger than its bound without reading it all', async () => {
    const huge = new Response(chunked(Buffer.alloc(updateLimits.manifestBytes + 10, 32), 4096), { status: 200 })
    const { instance } = updater({ manifest: [huge] })
    expect(await instance.check(true)).toMatchObject({ code: 'invalidFeed', detail: 'Too large' })
  })
  it('fails a download that stalls, and removes its partial file', async () => {
    const stalled = (signal: AbortSignal) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(payload.subarray(0, 100)))
        signal.addEventListener('abort', () => controller.error(signal.reason))
      }
    }), { status: 200 })
    const { instance, timers } = updater({ manifest: [json(manifest())], asset: [stalled] })
    const result = instance.check(true)
    await expect.poll(async () => (await readdir(join(dir, 'updates')).catch(() => [])).length).toBe(1)
    await expect.poll(() => timers.delays()).toContain(updateLimits.stallTimeoutMs)
    timers.fire(updateLimits.stallTimeoutMs)
    expect(await result).toMatchObject({ status: 'error', code: 'timeout', during: 'download' })
    expect(await readdir(join(dir, 'updates'))).toEqual([])
  })
  it('reports a folder it cannot write to before downloading', async () => {
    await writeFile(join(dir, 'updates'), 'a file where the folder should be')
    const { instance, requests } = updater({ manifest: [json(manifest())], asset: [file(payload)] }, { privateDir: false })
    const state = await instance.check(true)
    expect(state).toMatchObject({ status: 'error', during: 'download' })
    expect(requests).toHaveLength(1)
  })
  it('waits for Download Update while Automatically download updates is off', async () => {
    const { instance, requests } = updater({ manifest: [json(manifest())], asset: [file(payload)] }, { settings: () => ({ checkAutomatically: true, downloadAutomatically: false }) })
    expect(await instance.check(false)).toMatchObject({ status: 'available', version: '1.1.0', size: payload.length })
    expect(requests).toHaveLength(1)
    expect(await instance.download()).toMatchObject({ status: 'ready', version: '1.1.0' })
  })
  it('offers a release this copy cannot install without downloading it', async () => {
    const { instance, requests } = updater({ manifest: [json(manifest())] }, { kind: 'unsupported' })
    const state = await instance.check(true)
    expect(state).toMatchObject({ status: 'available', version: '1.1.0' })
    expect('size' in state).toBe(false)
    expect(requests).toHaveLength(1)
    expect(await instance.download()).toMatchObject({ status: 'available', version: '1.1.0' })
    expect(requests).toHaveLength(1)
  })
  it('uses a file an earlier run verified, and downloads again one that does not hash right', async () => {
    await import('node:fs/promises').then(fs => fs.mkdir(join(dir, 'updates')))
    await writeFile(join(dir, 'updates', 'Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe'), payload)
    await writeFile(join(dir, 'updates', 'Varia-SQL-Manager-1.0.5-Windows-x64-Setup.exe'), 'an older update')
    const first = updater({ manifest: [json(manifest())] })
    expect(await first.instance.check(false)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(first.requests).toHaveLength(1)
    await expect.poll(() => readdir(join(dir, 'updates'))).toEqual(['Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe'])
    await writeFile(join(dir, 'updates', 'Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe'), 'not the installer')
    const second = updater({ manifest: [json(manifest())], asset: [file(payload)] })
    expect(await second.instance.check(false)).toMatchObject({ status: 'ready' })
    expect(second.requests).toHaveLength(2)
  })
  it('in a folder it shares (portable, AppImage), writes and removes only its own hidden files', async () => {
    const shared = join(dir, 'apps')
    await import('node:fs/promises').then(fs => fs.mkdir(shared))
    await writeFile(join(shared, 'Varia-SQL-Manager-1.0.0-Windows-x64-Portable.exe'), 'the running copy')
    await writeFile(join(shared, '.Varia-SQL-Manager-1.0.5-Windows-x64-Portable.exe.update'), 'an older update')
    await writeFile(join(shared, 'notes.txt'), 'the user\'s')
    const { instance } = updater({ manifest: [json(manifest())], asset: [file(payload)] }, { kind: 'portable', downloadDir: shared, privateDir: false })
    expect(await instance.check(false)).toMatchObject({ status: 'ready' })
    expect(instance.readyFile?.file).toBe(join(shared, '.Varia-SQL-Manager-1.1.0-Windows-x64-Portable.exe.update'))
    await expect.poll(async () => (await readdir(shared)).sort()).toEqual(['.Varia-SQL-Manager-1.1.0-Windows-x64-Portable.exe.update', 'Varia-SQL-Manager-1.0.0-Windows-x64-Portable.exe', 'notes.txt'])
  })
  it('makes the downloaded AppImage executable', async () => {
    const { instance } = updater({ manifest: [json(manifest())], asset: [file(payload)] }, { kind: 'appimage' })
    await instance.check(false)
    if (process.platform !== 'win32') expect((await stat(instance.readyFile!.file)).mode & 0o111).toBe(0o111)
  })
  it('arms the verified file for exit only after Restart to Update, and a cancelled quit disarms it', async () => {
    const { instance } = updater({ manifest: [json(manifest())], asset: [file(payload)] })
    expect(await instance.arm()).toBe(false)
    await instance.check(false)
    expect(instance.takeArmed()).toBeUndefined()
    expect(await instance.arm()).toBe(true)
    instance.disarm()
    expect(instance.takeArmed()).toBeUndefined()
    expect(await instance.arm()).toBe(true)
    expect(instance.takeArmed()).toMatchObject({ version: '1.1.0' })
    expect(instance.takeArmed()).toBeUndefined()
  })
  it('does not install a verified file that was removed since', async () => {
    const { instance } = updater({ manifest: [json(manifest())], asset: [file(payload)] })
    await instance.check(false)
    await rm(instance.readyFile!.file)
    expect(await instance.arm()).toBe(false)
    expect(instance.state).toMatchObject({ status: 'error', code: 'integrity', during: 'install' })
  })
  it('shares one check between callers, and keeps a ready update when a later check fails', async () => {
    const { instance, requests } = updater({ manifest: [json(manifest()), new Error('net::ERR_INTERNET_DISCONNECTED')], asset: [file(payload)] })
    const [a, b] = [instance.check(true), instance.check(true)]
    expect(await a).toBe(await b)
    expect(requests).toHaveLength(2)
    expect(await instance.check(false)).toMatchObject({ status: 'ready', version: '1.1.0' })
  })
  it('checks automatically after start-up, every few hours, and sooner again after a failure', async () => {
    const { instance, timers, requests } = updater({ manifest: [new Error('net::ERR_NAME_NOT_RESOLVED'), json(manifest('1.0.0'))] })
    instance.start()
    expect(timers.delays()).toEqual([updateLimits.firstCheckMs])
    timers.fire(updateLimits.firstCheckMs)
    await expect.poll(() => timers.delays()).toEqual([updateLimits.retryMs])
    expect(instance.state).toMatchObject({ status: 'error', code: 'dns', manual: false })
    timers.fire(updateLimits.retryMs)
    await expect.poll(() => timers.delays()).toEqual([updateLimits.checkIntervalMs])
    expect(instance.state.status).toBe('upToDate')
    expect(requests).toHaveLength(2)
  })
  it('never checks while automatic checks are off, and Check for Updates still works', async () => {
    let settings = { checkAutomatically: false, downloadAutomatically: true }
    const { instance, timers } = updater({ manifest: [json(manifest('1.0.0'))] }, { settings: () => settings })
    instance.start()
    expect(timers.delays()).toEqual([])
    expect(await instance.check(true)).toMatchObject({ status: 'upToDate' })
    expect(timers.delays()).toEqual([])
    settings = { ...settings, checkAutomatically: true }
    instance.settingsChanged()
    expect(timers.delays()).toEqual([updateLimits.firstCheckMs])
    settings = { ...settings, checkAutomatically: false }
    instance.settingsChanged()
    expect(timers.delays()).toEqual([])
  })
  it('does nothing in a build that cannot check (development)', async () => {
    const { instance, requests, timers } = updater({}, { enabled: false })
    instance.start()
    expect(await instance.check(true)).toMatchObject({ status: 'idle', enabled: false })
    expect(requests).toEqual([])
    expect(timers.delays()).toEqual([])
  })
  it('keeps its failures to fixed sentences', () => {
    const failure = new UpdateFailure('proxy', 'net::ERR_TUNNEL_CONNECTION_FAILED')
    expect(failure.message).toBe('Your network\'s proxy refused the connection to GitHub.')
  })
})
