import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { downloadArtifact as download5 } from '@electron/get'
import { downloadVerifiedElectron, electronPreparationLimits, seedElectronChecksums, type ElectronArchiveOptions } from '../scripts/prepare-electron.mjs'

const require = createRequire(import.meta.url), get5Root = dirname(require.resolve('@electron/get'))
const { Cache: Cache5 } = await import(pathToFileURL(join(get5Root, 'Cache.js')).href)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const get3 = builderRequire('@electron/get'), get3Root = dirname(builderRequire.resolve('@electron/get'))
const { Cache: Cache3 } = builderRequire(join(get3Root, 'Cache.js'))
const { buildElectronArtifactConfig } = builderRequire('./out/util/electronGet.js')
const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
const bytes = Buffer.from('synthetic test archive; no executable is launched')
const version = '44.10.2', platform = 'win32', arch = 'x64'
const filename = `electron-v${version}-${platform}-${arch}.zip`
const canonical = `https://github.com/electron/electron/releases/download/v${version}/${filename}`
const checksums = { [filename]: createHash('sha256').update(bytes).digest('hex') }
async function fixture(): Promise<ElectronArchiveOptions> {
  await mkdir('artifacts', { recursive: true })
  const folder = await mkdtemp(join(resolve('artifacts'), 'electron-preparation-test-')); folders.push(folder)
  return { version, platform, arch, checksums, cacheRoot: join(folder, 'cache'), tempDirectory: join(folder, 'tmp') }
}

describe('verified Electron preparation', () => {
  it('shares the fallback ZIP and pinned checksums with both the installer and builder caches offline', async () => {
    const options = await fixture(), urls: string[] = [], signals: AbortSignal[] = []
    const archive = await downloadVerifiedElectron({ ...options, downloader: { async download(url, destination, { signal }) {
      urls.push(url); signals.push(signal)
      if (urls.length === 1) throw Object.assign(new Error('gateway timeout'), { response: { status: 504 } })
      await writeFile(destination, bytes)
    } } })
    expect(urls).toEqual([canonical, `${canonical}?download=1`])
    expect(signals[0]).toBe(signals[1])
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    const cache5 = new Cache5(options.cacheRoot), cache3 = new Cache3(options.cacheRoot)
    expect(cache5.getCachePath(canonical, filename)).toBe(cache5.getCachePath(`${canonical}?download=1`, filename))
    expect(cache3.getCachePath(canonical, filename)).toBe(cache3.getCachePath(`${canonical}?download=1`, filename))
    expect(cache5.getCachePath(canonical, filename)).toBe(cache3.getCachePath(canonical, filename))
    expect(archive).toBe(cache3.getCachePath(canonical, filename))
    const noNetwork = { download: vi.fn(async (url: string) => { throw new Error(`Unexpected network access: ${url}`) }) }
    expect(await download5({ ...options, artifactName: 'electron', downloader: noNetwork })).toBe(archive)
    const config = await buildElectronArtifactConfig({ version, platformName: platform, arch, artifactName: 'electron', electronDownload: { cache: options.cacheRoot } })
    expect(config.checksums).toEqual(checksums)
    expect(config.unsafelyDisableChecksums).toBe(false)
    expect(await get3.downloadArtifact({ ...config, downloader: noNetwork })).toBe(archive)
    expect(noNetwork.download).not.toHaveBeenCalled()
    expect(await readFile(archive)).toEqual(bytes)
    expect(await readFile(join(options.cacheRoot, `SHASUMS256.txt-${version}`), 'utf8')).toBe(`${checksums[filename]} *${filename}\n`)
  })

  it.each(['status', 'statusCode'])('stops after three transient %s failures', async statusKey => {
    const download = vi.fn(async () => { throw Object.assign(new Error('gateway timeout'), { response: { [statusKey]: 504 } }) })
    await expect(downloadVerifiedElectron({ ...await fixture(), downloader: { download } })).rejects.toThrow('gateway timeout')
    expect(download).toHaveBeenCalledTimes(3)
    expect(electronPreparationLimits).toEqual({ attempts: 3, deadlineMs: 180_000 })
  })

  it('seeds the npm-pinned manifest for all packaging targets during concurrent preparation', async () => {
    const options = await fixture(), pinned = require('electron/checksums.json'), pkg = require('electron/package.json')
    expect(pkg.version).toBe(version)
    await Promise.all([seedElectronChecksums(options.cacheRoot, version, pinned), seedElectronChecksums(options.cacheRoot, version, pinned)])
    for (const [platformName, arch] of [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
      const config = await buildElectronArtifactConfig({ version, platformName, arch, artifactName: 'electron', electronDownload: { cache: options.cacheRoot } })
      const filename = `electron-v${version}-${platformName}-${arch}.zip`
      expect(config.checksums[filename]).toMatch(/^[a-f0-9]{64}$/)
      expect(config.checksums[filename]).toBe(pinned[filename])
      expect(config.unsafelyDisableChecksums).toBe(false)
    }
  })

  it('rejects a checksum mismatch without retrying or publishing the corrupted archive', async () => {
    const options = await fixture(), download = vi.fn(async (_url: string, destination: string) => { await writeFile(destination, 'different bytes') })
    await expect(downloadVerifiedElectron({ ...options, downloader: { download } })).rejects.toThrow('did not match expected checksum')
    expect(download).toHaveBeenCalledOnce()
    await expect(readFile(new Cache5(options.cacheRoot).getCachePath(canonical, filename))).rejects.toThrow()
  })

  it('does not retry a permanent HTTP failure', async () => {
    const download = vi.fn(async () => { throw Object.assign(new Error('not found'), { response: { status: 404 } }) })
    await expect(downloadVerifiedElectron({ ...await fixture(), downloader: { download } })).rejects.toThrow('not found')
    expect(download).toHaveBeenCalledOnce()
  })

  it('does not retry after the shared deadline cancels a download', async () => {
    const controller = new AbortController(), download = vi.fn(async (_url: string, _destination: string, { signal }: { signal: AbortSignal }) => {
      controller.abort(new Error('deadline exceeded'))
      signal.throwIfAborted()
    })
    await expect(downloadVerifiedElectron({ ...await fixture(), signal: controller.signal, downloader: { download } })).rejects.toThrow('deadline exceeded')
    expect(download).toHaveBeenCalledOnce()
  })

  it('prepares host smoke binaries and exact packaging targets before normal builder extraction', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')), hook = await readFile('build/sqltools-service-check.cjs', 'utf8')
    expect(pkg.scripts['electron:prepare']).toBe('node scripts/prepare-electron.mjs')
    expect(pkg.scripts['build:smoke']).toMatch(/^npm run electron:prepare -- --install && /)
    expect(hook).toContain('await prepareElectron({ projectRoot: context.packager.projectDir, platform: context.electronPlatformName, arch: Arch[context.arch] })')
    expect(hook).toContain('context.packager.config.electronDownload = { cache: electron.cacheRoot }')
    expect(hook).not.toContain('electronDist')
  })
})
