import { downloadArtifact } from '@electron/get'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const exec = promisify(execFile)
export const electronPreparationLimits = { attempts: 3, deadlineMs: 180_000 }
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])
const root = fileURLToPath(new URL('../', import.meta.url))

function transient(error) {
  const status = error?.response?.status ?? error?.response?.statusCode
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500 && status <= 599
  return networkCodes.has(error?.code) || networkCodes.has(error?.cause?.code) || error instanceof TypeError && error.message === 'fetch failed'
}
function validChecksums(checksums) {
  const entries = Object.entries(checksums)
  if (!entries.length || entries.some(([name, digest]) => /[\r\n]/.test(name) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))
    throw new Error('The installed Electron checksum manifest is invalid.')
  return entries
}

/** Both installed @electron/get generations accept this seeded manifest and share the canonical ZIP cache. */
export async function seedElectronChecksums(cacheRoot, version, checksums) {
  const content = validChecksums(checksums).map(([name, digest]) => `${digest} *${name}`).join('\n') + '\n'
  await mkdir(cacheRoot, { recursive: true })
  const destination = join(cacheRoot, `SHASUMS256.txt-${version}`)
  if (await readFile(destination, 'utf8').catch(() => undefined) === content) return
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    try { await rename(temporary, destination) }
    catch (error) { if (await readFile(destination, 'utf8').catch(() => undefined) !== content) throw error }
  }
  finally { await rm(temporary, { force: true }) }
}

/** Retry transport failures only. Every downloaded or cached ZIP is verified against the npm-pinned manifest. */
export async function downloadVerifiedElectron({ version, platform, arch, checksums, cacheRoot, tempDirectory,
  signal = AbortSignal.timeout(electronPreparationLimits.deadlineMs), downloader }) {
  const filename = `electron-v${version}-${platform}-${arch}.zip`
  validChecksums(checksums)
  if (!Object.hasOwn(checksums, filename)) throw new Error(`The installed Electron package has no checksum for ${filename}.`)
  await mkdir(tempDirectory, { recursive: true })
  await seedElectronChecksums(cacheRoot, version, checksums)
  const canonical = `https://github.com/electron/electron/releases/download/v${version}/${filename}`
  for (let attempt = 0; attempt < electronPreparationLimits.attempts; attempt++) {
    signal.throwIfAborted()
    try {
      return await downloadArtifact({ version, platform, arch, artifactName: 'electron', checksums, cacheRoot,
        tempDirectory, downloader, downloadOptions: { signal },
        mirrorOptions: { resolveAssetURL: async () => attempt === 0 ? canonical : `${canonical}?download=1` } })
    } catch (error) {
      if (attempt + 1 === electronPreparationLimits.attempts || signal.aborted || !transient(error)) throw error
    }
  }
}

function installEnvironment(cacheRoot, platform, arch) {
  const env = { ...process.env }
  // The cache just prepared contains the exact trusted release. Do not let developer mirror overrides change it.
  for (const key of Object.keys(env))
    if (/^(?:ELECTRON_(?:MIRROR|NIGHTLY_MIRROR|CUSTOM_DIR|CUSTOM_FILENAME|CUSTOM_VERSION|OVERRIDE_DIST_PATH)|npm_config_electron_(?:mirror|nightly_?mirror|custom_?dir|custom_?filename|custom_?version)|npm_package_config_electron_(?:mirror|nightly_?mirror|custom_?dir|custom_?filename|custom_?version))$/i.test(key)) delete env[key]
  return { ...env, electron_config_cache: cacheRoot, force_no_cache: 'false', electron_use_remote_checksums: '',
    npm_config_electron_use_remote_checksums: '', ELECTRON_INSTALL_PLATFORM: platform, ELECTRON_INSTALL_ARCH: arch, npm_config_arch: arch }
}

/** Build-time only. Packaging should call without install; smoke preparation explicitly installs the host distribution. */
export async function prepareElectron({ projectRoot = root, platform = process.platform, arch = process.arch, install = false } = {}) {
  if (install && (platform !== process.platform || arch !== process.arch)) throw new Error('Only the host Electron distribution can be installed for smoke tests.')
  const require = createRequire(join(projectRoot, 'package.json'))
  const pkg = require('electron/package.json'), project = require(join(projectRoot, 'package.json'))
  if (pkg.version !== project.devDependencies.electron) throw new Error('Installed Electron does not match the exact package.json pin.')
  const checksums = require('electron/checksums.json')
  const cacheRoot = resolve(projectRoot, 'artifacts/electron-cache'), tempDirectory = resolve(projectRoot, 'artifacts/electron-download-tmp')
  const signal = AbortSignal.timeout(electronPreparationLimits.deadlineMs)
  const archivePath = await downloadVerifiedElectron({ version: pkg.version, platform, arch, checksums, cacheRoot, tempDirectory, signal })
  if (install) await exec(process.execPath, [join(dirname(require.resolve('electron/package.json')), 'install.js')],
    { cwd: projectRoot, env: installEnvironment(cacheRoot, platform, arch), windowsHide: true, signal, maxBuffer: 1024 * 1024 })
  return { version: pkg.version, platform, arch, cacheRoot, archivePath, installed: install }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { platform: { type: 'string' }, arch: { type: 'string' }, install: { type: 'boolean', default: false } } })
  try { console.log(JSON.stringify(await prepareElectron({ platform: values.platform, arch: values.arch, install: values.install }))) }
  catch (error) { console.error(error instanceof Error ? error.message : 'Electron preparation failed.'); process.exitCode = 1 }
}
