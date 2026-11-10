import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyUpdateError, httpFailure, StagingBusy, UpdateFailure, Updater, type UpdaterOptions, type UpdateSettings, type UpdateStaging } from '../src/main/updater'
import { assetFor, compareVersions, legacyAssetKinds, stagedAssetFor, updateFeedUrl, updateLimits, updateManifestSchema, updateStatusText, type UpdateManifest, type UpdateState } from '../src/shared/updates'

const payload = Buffer.from('Varia SQL Manager 1.1.0 installer bytes '.repeat(400))
const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('base64')
// The same release as an archive, which an installed Windows build stages.
const archive = Buffer.from('Varia SQL Manager 1.1.0 archive bytes '.repeat(300))
const manifest = (version = '1.1.0', bytes = payload): UpdateManifest => ({
  schema: 2, version, assets: [
    { name: `Varia-SQL-Manager-${version}-Windows-x64-Setup.exe`, kind: 'win-setup', arch: 'x64', size: bytes.length, sha512: sha512(bytes) },
    { name: `Varia-SQL-Manager-${version}-Windows-x64-Portable.exe`, kind: 'win-portable', arch: 'x64', size: bytes.length, sha512: sha512(bytes) },
    { name: `Varia-SQL-Manager-${version}-linux-x86_64.AppImage`, kind: 'linux-appimage', arch: 'x64', size: bytes.length, sha512: sha512(bytes) },
    { name: `Varia-SQL-Manager-${version}-mac-arm64.dmg`, kind: 'mac-dmg', arch: 'arm64', size: bytes.length, sha512: sha512(bytes) }
  ]
})
const withArchive = (version = '1.1.0'): UpdateManifest => {
  const value = manifest(version)
  return { ...value, assets: [...value.assets, { name: `Varia-SQL-Manager-${version}-win-x64.zip`, kind: 'win-zip', arch: 'x64', size: archive.length, sha512: sha512(archive) }] }
}

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
  it('keeps only files with a release name, a bounded size and a checksum, and refuses a manifest that is not one', () => {
    expect(updateManifestSchema.parse(manifest())).toEqual(manifest())
    const bad = (change: (value: UpdateManifest) => unknown) => updateManifestSchema.safeParse(change(structuredClone(manifest()))).success
    expect(bad(value => ({ ...value, schema: 1 }))).toBe(false)
    expect(bad(value => ({ ...value, version: '1.1' }))).toBe(false)
    expect(bad(value => ({ ...value, assets: 'none' }))).toBe(false)
    // A file this build could never safely download is not offered; the others still are.
    const without = (change: (asset: UpdateManifest['assets'][number]) => unknown) => {
      const value = structuredClone(manifest()) as { assets: unknown[] }
      value.assets[0] = change(manifest().assets[0]!)
      const parsed = updateManifestSchema.parse(value)
      expect(parsed.assets).toEqual(manifest().assets.slice(1))
      expect(assetFor(parsed, 'nsis', 'x64')).toBeUndefined()
      expect(assetFor(parsed, 'portable', 'x64')).toBeDefined()
    }
    without(asset => ({ ...asset, name: '../Varia-SQL-Manager-1.1.0.exe' }))
    without(asset => ({ ...asset, name: 'Varia-SQL-Manager-1.1.0/x.exe' }))
    without(asset => ({ ...asset, name: 'Varia-SQL-Manager-1.1.0.msi' }))
    without(asset => ({ ...asset, size: updateLimits.assetBytes + 1 }))
    without(asset => ({ ...asset, size: 0 }))
    without(asset => ({ ...asset, sha512: 'abc' }))
    without(asset => ({ ...asset, arch: 'universal' }))
  })
  // Builds up to 0.7.0 refused a manifest with anything they did not know, so a new kind of file would have stopped every
  // one of them from updating. A later release's additions are now left out instead.
  it('leaves out what a later release adds: fields, and files of kinds it does not know', () => {
    const later = { ...manifest(), channel: 'stable', releasedAt: '2027-01-02T03:04:05+01:00', assets: [...manifest().assets.map(asset => ({ ...asset, signature: 'x' })), { name: 'whatever', kind: 'win-msix', arch: 'x64' }, 'not an asset'] }
    const parsed = updateManifestSchema.parse(later)
    expect(parsed).toEqual(manifest())
    expect(updateManifestSchema.safeParse({ ...manifest(), assets: Array.from({ length: updateLimits.assets + 1 }, () => ({ kind: 'win-msix' })) }).success).toBe(false)
  })
  it('reads the manifest that carries the archive, leaving the first one to the builds that refuse a new kind', () => {
    expect(updateFeedUrl).toMatch(/\/releases\/latest\/download\/varia-update-v2\.json$/)
    expect(legacyAssetKinds).toEqual(['win-setup', 'win-portable', 'linux-appimage', 'mac-dmg', 'mac-zip'])
    expect(stagedAssetFor(withArchive(), 'nsis', 'x64')?.name).toBe('Varia-SQL-Manager-1.1.0-win-x64.zip')
    expect(stagedAssetFor(withArchive(), 'nsis', 'arm64')).toBeUndefined()
    expect(stagedAssetFor(withArchive(), 'portable', 'x64')).toBeUndefined()
    expect(stagedAssetFor(manifest(), 'nsis', 'x64')).toBeUndefined()
  })
  it('picks the file for the build\'s kind and architecture', () => {
    const value = withArchive()
    expect(assetFor(value, 'nsis', 'x64')?.kind).toBe('win-setup')
    expect(assetFor(value, 'portable', 'x64')?.kind).toBe('win-portable')
    expect(assetFor(value, 'appimage', 'x64')?.kind).toBe('linux-appimage')
    expect(assetFor(value, 'appimage', 'arm64')).toBeUndefined()
    // macOS builds are unsupported: the release's disk image is never theirs to download.
    expect(assetFor(value, 'unsupported', 'arm64')).toBeUndefined()
  })
  it('says what the status bar shows, and hides what it need not', () => {
    const base = { currentVersion: '1.0.0', kind: 'nsis', enabled: true } as const
    expect(updateStatusText({ ...base, status: 'idle' })).toBeUndefined()
    expect(updateStatusText({ ...base, status: 'upToDate', checkedAt: 0 })).toBeUndefined()
    expect(updateStatusText({ ...base, status: 'checking', manual: false })).toBeUndefined()
    expect(updateStatusText({ ...base, status: 'checking', manual: true })).toBe('Checking for updates…')
    expect(updateStatusText({ ...base, status: 'downloading', version: '1.1.0', received: 50, total: 200 })).toBe('Downloading update 25%')
    expect(updateStatusText({ ...base, status: 'ready', version: '1.1.0' })).toBe('Restart to update to 1.1.0')
    expect(updateStatusText({ ...base, status: 'preparing', version: '1.1.0' })).toBe('Preparing update…')
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
  // The file is run from a folder other programs can write to: its size alone does not say it is still the release's.
  it('hashes the verified file again at Restart to Update, and does not install one that changed without changing size', async () => {
    const { instance } = updater({ manifest: [json(manifest())], asset: [file(payload)] })
    await instance.check(false)
    const changed = Buffer.from(payload)
    changed[changed.length - 1] ^= 1
    await writeFile(instance.readyFile!.file, changed)
    expect(await instance.arm()).toBe(false)
    expect(instance.takeArmed()).toBeUndefined()
    expect(instance.state).toMatchObject({ status: 'error', code: 'integrity', during: 'install', version: '1.1.0' })
  })
  // The status bar still offers the restart while the feed is read again: choosing it then must not answer "nothing ready".
  it('waits for a quiet re-check of the feed, then restarts to update', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let checks = 0
    const { instance } = updater({}, { fetch: async url => {
      if (!url.endsWith('.json')) return file(payload)
      if (++checks === 2) await gate
      return json(manifest())
    } })
    await instance.check(false)
    const recheck = instance.check(false)
    const armed = instance.arm()
    release()
    expect(await recheck).toMatchObject({ status: 'ready' })
    expect(await armed).toBe(true)
    expect(instance.takeArmed()).toMatchObject({ version: '1.1.0' })
  })
  // Otherwise Varia would close minutes after the click, once the newer release had downloaded, into one nobody chose.
  it('drops a restart that was waiting on a re-check once that finds a newer release', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let checks = 0
    const { instance } = updater({}, { fetch: async url => {
      if (!url.endsWith('.json')) return file(payload)
      if (++checks === 2) { await gate; return json(manifest('1.2.0')) }
      return json(manifest())
    } })
    await instance.check(false)
    const recheck = instance.check(false)
    const armed = instance.arm()
    release()
    expect(await recheck).toMatchObject({ status: 'ready', version: '1.2.0' })
    expect(await armed).toBe(false)
    expect(instance.takeArmed()).toBeUndefined()
    // Asked for again, with the newer release ready, it is that one.
    expect(await instance.arm()).toBe(true)
    expect(instance.takeArmed()).toMatchObject({ version: '1.2.0' })
  })
  // A check left on "checking" would keep Check for Updates disabled for the rest of the run, and end the schedule.
  it('turns anything a check meets into a state, and keeps checking', async () => {
    let broken = true
    const { instance, timers } = updater({ manifest: [json(manifest()), json(manifest('1.0.0'))] }, { settings: () => { if (broken) { broken = false; return { checkAutomatically: true, get downloadAutomatically(): boolean { throw new RangeError('settings') } } } return { checkAutomatically: true, downloadAutomatically: true } } })
    expect(await instance.check(false)).toMatchObject({ status: 'error', code: 'unknown', during: 'check', manual: false })
    expect(await instance.check(true)).toMatchObject({ status: 'upToDate' })
    void timers
  })
  it('has nothing to restart into once a newer release has no file for this build', async () => {
    const newer = { ...manifest('1.2.0'), assets: manifest('1.2.0').assets.filter(asset => asset.kind !== 'win-setup') }
    const { instance } = updater({ manifest: [json(manifest()), json(newer)], asset: [file(payload)] })
    await instance.check(false)
    expect(await instance.arm()).toBe(true)
    expect(await instance.check(false)).toMatchObject({ status: 'available', version: '1.2.0' })
    expect(instance.readyFile).toBeUndefined()
    expect(instance.takeArmed()).toBeUndefined()
    expect(await instance.arm()).toBe(false)
  })
  it('lets Restart to Update be chosen twice, and starts no check while it verifies', async () => {
    const { instance, requests } = updater({ manifest: [json(manifest())], asset: [file(payload)] })
    await instance.check(false)
    const [first, second, checked] = [instance.arm(), instance.arm(), instance.check(true)]
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(await checked).toMatchObject({ status: 'ready' })
    expect(requests).toHaveLength(2)
    expect(await instance.arm()).toBe(true)
    expect(instance.takeArmed()).toMatchObject({ version: '1.1.0', staged: false })
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

/** Staging as the helper does it, without the helper: what is staged, and what was asked of it. */
function fakeStaging(change: Partial<UpdateStaging> = {}) {
  const calls: string[] = []
  const held: { staged?: { version: string; sha512: string }; failure?: { version: string; reported: boolean } } = {}
  const staging: UpdateStaging = {
    available: async () => true,
    staged: async (version, hash) => held.staged?.version === version && held.staged.sha512 === hash,
    stage: async (path, version, hash) => {
      calls.push(`stage ${basename(path)}`)
      expect(await readFile(path)).toEqual(archive)
      held.staged = { version, sha512: hash }
    },
    clear: async () => { calls.push('clear'); delete held.staged },
    remove: async () => { calls.push('remove'); delete held.staged; delete held.failure },
    failure: async () => held.failure,
    markFailed: async (version, reported) => { calls.push(`failed ${version}`); held.failure = { version, reported } },
    ...change
  }
  return { staging, calls, held }
}

describe('Updater, staging the release beside the installation', () => {
  it('downloads the archive, unpacks it while Varia runs, and keeps only the unpacked copy', async () => {
    const { staging, calls } = fakeStaging()
    const { instance, states, requests } = updater({ manifest: [json(withArchive())], asset: [file(archive)] }, { staging })
    expect(await instance.check(false)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(requests[1]).toBe('https://feed.test/download/v1.1.0/Varia-SQL-Manager-1.1.0-win-x64.zip')
    expect([...new Set(states.map(item => item.status))]).toEqual(['checking', 'downloading', 'preparing', 'ready'])
    expect(calls).toEqual(['stage Varia-SQL-Manager-1.1.0-win-x64.zip'])
    expect(instance.readyFile).toMatchObject({ version: '1.1.0', staged: true, sha512: sha512(archive) })
    await expect.poll(() => readdir(join(dir, 'updates'))).toEqual([])
    expect(await instance.arm()).toBe(true)
    expect(instance.takeArmed()).toMatchObject({ version: '1.1.0', staged: true })
  })
  it('uses the installer where the installation cannot be staged, or the release has no archive', async () => {
    const elsewhere = fakeStaging({ available: async () => false })
    const first = updater({ manifest: [json(withArchive())], asset: [file(payload)] }, { staging: elsewhere.staging })
    expect(await first.instance.check(false)).toMatchObject({ status: 'ready' })
    expect(first.requests[1]).toMatch(/Windows-x64-Setup\.exe$/)
    expect(first.instance.readyFile?.staged).toBe(false)
    expect(elsewhere.calls).toEqual([])
    const without = fakeStaging()
    const second = updater({ manifest: [json(manifest())], asset: [file(payload)] }, { staging: without.staging })
    expect(await second.instance.check(false)).toMatchObject({ status: 'ready' })
    expect(second.instance.readyFile?.staged).toBe(false)
    expect(without.calls).toEqual([])
  })
  it('falls back to the installer when the archive cannot be unpacked, without an error', async () => {
    const { staging, calls, held } = fakeStaging({ stage: async () => { throw new Error('The update could not be unpacked.') } })
    const { instance, states, requests } = updater({ manifest: [json(withArchive())], asset: [file(archive), file(payload)] }, { staging })
    expect(await instance.check(true)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(requests.slice(1).map(url => url.split('/').at(-1))).toEqual(['Varia-SQL-Manager-1.1.0-win-x64.zip', 'Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe'])
    expect(states.some(item => item.status === 'error')).toBe(false)
    expect(calls).toEqual(['clear', 'failed 1.1.0'])
    // Recorded as already said: it fell back by itself, and the next run has nothing to report.
    expect(held.failure).toEqual({ version: '1.1.0', reported: true })
    expect(instance.readyFile).toMatchObject({ staged: false, file: join(dir, 'updates', 'Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe') })
    await expect.poll(() => readdir(join(dir, 'updates'))).toEqual(['Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe'])
  })
  // Otherwise every check would download the archive, fail to unpack it, and download the installer.
  it('does not stage a release again once it could not be unpacked, in this run or the next', async () => {
    const { staging, calls } = fakeStaging({ stage: async () => { calls.push('stage'); throw new Error('The update could not be unpacked.') } })
    const first = updater({ manifest: [json(withArchive()), json(withArchive())], asset: [file(archive), new Response('', { status: 503 }), file(payload)] }, { staging })
    expect(await first.instance.check(true)).toMatchObject({ status: 'error', code: 'server', during: 'download' })
    expect(await first.instance.check(true)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(first.requests.filter(url => !url.endsWith('.json')).map(url => url.split('/').at(-1))).toEqual(['Varia-SQL-Manager-1.1.0-win-x64.zip', 'Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe', 'Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe'])
    expect(calls.filter(call => call === 'stage')).toHaveLength(1)
    // The next run: the installer that is already there, verified, is what installs. Nothing is downloaded or staged.
    const next = updater({ manifest: [json(withArchive())] }, { staging })
    next.instance.start()
    expect(await next.instance.check(false)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(next.requests).toHaveLength(1)
    expect(next.states.some(item => item.status === 'error')).toBe(false)
    expect(next.instance.readyFile?.staged).toBe(false)
    expect(calls.filter(call => call === 'stage')).toHaveLength(1)
    // A newer release is staged again.
    const later = updater({ manifest: [json(withArchive('1.2.0'))], asset: [file(archive)] }, { staging })
    await later.instance.check(false)
    expect(calls.filter(call => call === 'stage')).toHaveLength(2)
  })
  it('uses an archive an earlier run downloaded, and keeps it when Varia closes while it is being unpacked', async () => {
    let unpacking!: () => void
    const started = new Promise<void>(resolve => { unpacking = resolve })
    const { staging, calls } = fakeStaging({ stage: (_path, _version, _hash, signal) => new Promise<void>((_resolve, reject) => { unpacking(); signal.addEventListener('abort', () => reject(new Error('aborted'))) }) })
    const first = updater({ manifest: [json(withArchive())], asset: [file(archive), file(payload)] }, { staging })
    const checking = first.instance.check(false)
    await started
    first.instance.dispose()
    expect(await checking).toMatchObject({ status: 'preparing' })
    // Closing is not a failure to unpack: nothing is recorded, the installer is not fetched, and the archive stays.
    expect(first.requests).toHaveLength(2)
    expect(calls).toEqual([])
    expect(await readdir(join(dir, 'updates'))).toEqual(['Varia-SQL-Manager-1.1.0-win-x64.zip'])
    const next = fakeStaging()
    const second = updater({ manifest: [json(withArchive())] }, { staging: next.staging })
    expect(await second.instance.check(false)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(second.requests).toHaveLength(1)
    expect(next.calls).toEqual(['stage Varia-SQL-Manager-1.1.0-win-x64.zip'])
  })
  it('reports a failed archive download as a download failure, without fetching the installer too', async () => {
    const { staging } = fakeStaging()
    const { instance, requests } = updater({ manifest: [json(withArchive())], asset: [new Response('', { status: 503 })] }, { staging })
    expect(await instance.check(true)).toMatchObject({ status: 'error', code: 'server', during: 'download', version: '1.1.0' })
    expect(requests).toHaveLength(2)
  })
  it('uses a release an earlier run staged without downloading it again', async () => {
    const { staging, held, calls } = fakeStaging()
    held.staged = { version: '1.1.0', sha512: sha512(archive) }
    const { instance, requests } = updater({ manifest: [json(withArchive())] }, { staging })
    expect(await instance.check(false)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(requests).toHaveLength(1)
    expect(calls).toEqual([])
    expect(instance.readyFile?.staged).toBe(true)
  })
  it('offers the archive\'s size while Automatically download updates is off, and stages on Download Update', async () => {
    const { staging } = fakeStaging()
    const { instance } = updater({ manifest: [json(withArchive())], asset: [file(archive)] }, { staging, settings: () => ({ checkAutomatically: true, downloadAutomatically: false }) })
    expect(await instance.check(false)).toMatchObject({ status: 'available', size: archive.length })
    expect(await instance.download()).toMatchObject({ status: 'ready' })
    expect(instance.readyFile?.staged).toBe(true)
  })
  it('does not restart into a staged release that is no longer there', async () => {
    const { staging, held, calls } = fakeStaging()
    const { instance } = updater({ manifest: [json(withArchive())], asset: [file(archive)] }, { staging })
    await instance.check(false)
    delete held.staged
    calls.length = 0
    expect(await instance.arm()).toBe(false)
    expect(instance.takeArmed()).toBeUndefined()
    // Not a changed download: the staged release is gone (or its folder is no longer this user's alone). What is left
    // of it is removed, and this release installs with the installer, as the message says.
    expect(instance.state).toMatchObject({ status: 'error', code: 'staged', during: 'install', manual: true, version: '1.1.0' })
    expect(instance.state.status === 'error' && instance.state.hint).toContain('installer')
    expect(calls).toEqual(['clear', 'failed 1.1.0'])
    expect(held.failure).toEqual({ version: '1.1.0', reported: true })
  })
  // Varia was ended while a helper was unpacking, and that helper is still at it.
  it('installs with the installer for now while another stage is still running, and records no failure', async () => {
    const { staging, calls, held } = fakeStaging({ stage: async () => { throw new StagingBusy() } })
    const { instance, requests } = updater({ manifest: [json(withArchive())], asset: [file(archive), file(payload)] }, { staging })
    expect(await instance.check(false)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(instance.readyFile?.staged).toBe(false)
    expect(requests).toHaveLength(3)
    // Nothing that helper is writing is removed, and the next run may find its release staged.
    expect(calls).toEqual([])
    expect(held.failure).toBeUndefined()
    await expect.poll(() => readdir(join(dir, 'updates')), { timeout: 5000 }).toEqual(['Varia-SQL-Manager-1.1.0-Windows-x64-Setup.exe'])
  })
  // The helper put the old version back (a file was in use) and started it: this run says so, and installs with the installer.
  it('says that the last restart could not swap the release in, and installs it with the installer instead', async () => {
    const { staging, held, calls } = fakeStaging()
    held.failure = { version: '1.1.0', reported: false }
    held.staged = { version: '1.1.0', sha512: sha512(archive) }
    const { instance, requests } = updater({ manifest: [json(withArchive())], asset: [file(payload)] }, { staging })
    instance.start()
    await expect.poll(() => instance.state).toMatchObject({ status: 'error', code: 'staged', during: 'install', manual: false, version: '1.1.0' })
    expect(calls).toEqual(['clear', 'failed 1.1.0'])
    expect(await instance.check(false)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(requests[1]).toMatch(/Windows-x64-Setup\.exe$/)
    expect(instance.readyFile?.staged).toBe(false)
    // Closed without restarting: the run after that says nothing more, and still installs with the installer it has.
    const next = updater({ manifest: [json(withArchive())] }, { staging })
    next.instance.start()
    expect(await next.instance.check(false)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(next.states.some(item => item.status === 'error')).toBe(false)
    expect(next.requests).toHaveLength(1)
    expect(next.instance.readyFile?.staged).toBe(false)
    expect(calls).toEqual(['clear', 'failed 1.1.0'])
  })
  it('says nothing of a failed swap that a later restart got past', async () => {
    const { staging, held, calls } = fakeStaging()
    held.failure = { version: '1.0.0', reported: false }
    const { instance, states } = updater({ manifest: [json(withArchive())], asset: [file(archive)] }, { staging })
    instance.start()
    expect(await instance.check(false)).toMatchObject({ status: 'ready', version: '1.1.0' })
    expect(instance.readyFile?.staged).toBe(true)
    expect(states.some(item => item.status === 'error')).toBe(false)
    expect(calls).toEqual(['stage Varia-SQL-Manager-1.1.0-win-x64.zip'])
  })
  it('removes everything staging left once the running version is the latest', async () => {
    const { staging, calls, held } = fakeStaging()
    held.failure = { version: '1.0.0', reported: true }
    const { instance } = updater({ manifest: [json(withArchive('1.0.0'))] }, { staging })
    expect(await instance.check(false)).toMatchObject({ status: 'upToDate' })
    await expect.poll(() => calls).toEqual(['remove'])
    expect(held.failure).toBeUndefined()
  })
})
