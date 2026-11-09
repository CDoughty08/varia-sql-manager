// Build-time preparation only. The application never downloads or installs a language server at runtime.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const exec = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const sqlToolsManifest = JSON.parse(readFileSync(join(projectRoot, 'build', 'sqltools-service.json'), 'utf8'))
export const markerName = '.varia-sqltools-service.json'
export const executableName = rid => `MicrosoftSqlToolsServiceLayer${rid.startsWith('win-') ? '.exe' : ''}`
export function hostRid(platform = process.platform, arch = process.arch) {
  const os = { win32: 'win', linux: 'linux', darwin: 'osx' }[platform]
  const rid = `${os}-${arch}`
  if (!Object.hasOwn(sqlToolsManifest.platforms, rid)) throw new Error(`SQL Tools Service is not bundled for ${platform}/${arch}.`)
  return rid
}
export const archiveUrl = (rid, manifest = sqlToolsManifest) => `https://github.com/microsoft/sqltoolsservice/releases/download/${manifest.version}/${manifest.platforms[rid].archive}`
export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) hash.update(chunk)
  return hash.digest('hex')
}
export function safeArchiveEntries(listing) {
  const entries = listing.trim().split(/\r?\n/).filter(Boolean)
  if (!entries.length || entries.length > 8192) throw new Error('SQL Tools Service archive has an invalid entry count.')
  for (const entry of entries) {
    if (isAbsolute(entry) || /^[\\/]|[\\:\x00-\x1f]/.test(entry) || entry.split('/').includes('..'))
      throw new Error('SQL Tools Service archive contains an unsafe path.')
  }
  return entries
}
function inside(base, path) {
  const target = resolve(path), root = resolve(base)
  const compare = value => process.platform === 'win32' ? value.toLowerCase() : value
  if (!compare(target).startsWith(compare(root + sep))) throw new Error('The generated SQL Tools Service path is outside artifacts.')
  return target
}
async function removeGenerated(base, path) { await rm(inside(base, path), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
/** Windows scanners can briefly hold newly verified files or directories without delete sharing. */
export async function renamePreparedArtifact(from, to, platform = process.platform, move = rename) {
  for (let attempt = 1; ; attempt++) {
    try { return await move(from, to) }
    catch (error) {
      if (platform !== 'win32' || attempt === 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** attempt, 500)))
    }
  }
}
async function distributionFiles(folder, prefix = '') {
  const files = []
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error('The SQL Tools Service distribution contains a symbolic link.')
    if (entry.isDirectory()) files.push(...await distributionFiles(folder, name))
    else if (entry.isFile() && name !== markerName) files.push(name)
    else if (!entry.isFile()) throw new Error('The SQL Tools Service distribution contains a non-regular file.')
  }
  return files.sort()
}
async function inventory(folder) {
  const paths = await distributionFiles(folder), files = []
  // Bound open streams, while avoiding a separate serial antivirus/file-open wait for every runtime assembly on Windows.
  for (let at = 0; at < paths.length; at += 16)
    files.push(...await Promise.all(paths.slice(at, at + 16).map(async path => ({ path, sha256: await sha256(join(folder, path)) }))))
  return files
}
/** Checks the full prepared distribution, including the runtime and preserved notices, without network access. */
export async function sqlToolsServiceProblems(folder, rid = hostRid(), manifest = sqlToolsManifest) {
  const problems = []
  let marker
  try { marker = JSON.parse(await readFile(join(folder, markerName), 'utf8')) } catch { return ['SQL Tools Service preparation marker is missing or invalid.'] }
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (!record(marker) || typeof marker.version !== 'string' || typeof marker.rid !== 'string' || !digest(marker.archiveSha256))
    return ['SQL Tools Service preparation marker is missing or invalid.']
  const entry = manifest.platforms[rid]
  if (!entry || marker.version !== manifest.version || marker.rid !== rid || marker.archiveSha256 !== entry.sha256)
    return ['SQL Tools Service does not match the pinned version and target.']
  if (!Array.isArray(marker.files) || marker.files.length < 3 || marker.files.length > 8192) return ['SQL Tools Service file inventory is invalid.']
  const expected = new Set()
  for (const file of marker.files) {
    if (!record(file) || typeof file.path !== 'string' || !digest(file.sha256) || expected.has(file.path))
      return ['SQL Tools Service file inventory is invalid.']
    try {
      const paths = safeArchiveEntries(file.path)
      if (paths.length !== 1 || paths[0] !== file.path) throw new Error('Invalid inventory path.')
      inside(folder, join(folder, file.path))
    } catch { return ['SQL Tools Service file inventory is invalid.'] }
    expected.add(file.path)
  }
  let actual
  try { actual = new Map((await inventory(folder)).map(file => [file.path, file.sha256])) }
  catch { return ['SQL Tools Service distribution contains missing, unreadable or non-regular files.'] }
  for (const required of [executableName(rid), 'MicrosoftSqlToolsServiceLayer.dll', 'MicrosoftSqlToolsServiceLayer.runtimeconfig.json', 'Notice.txt', 'LICENSE.SqlToolsService.txt'])
    if (!expected.has(required)) problems.push(`SQL Tools Service is missing ${required}.`)
  for (const file of marker.files)
    if (!actual.has(file.path) || actual.get(file.path) !== file.sha256) problems.push(`SQL Tools Service file failed verification: ${file.path}.`)
  for (const file of actual.keys()) if (!expected.has(file)) problems.push(`SQL Tools Service contains an unexpected file: ${file}.`)
  return problems
}
class DownloadError extends Error {
  constructor(message, retryable = false) { super(message); this.retryable = retryable }
}
function retryableDownload(error) {
  if (error instanceof DownloadError) return error.retryable
  if (error instanceof TypeError || error?.name === 'TimeoutError' || error?.name === 'AbortError') return true
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(error?.code)
}
/** Retry only transient transport failures; all URLs serve the same official asset and preparation still checks its pin. */
export async function downloadSqlToolsArchive(url, destination, assetId) {
  if (assetId !== undefined && (!Number.isSafeInteger(assetId) || assetId <= 0)) throw new Error('The SQL Tools Service release asset ID is invalid.')
  const signal = AbortSignal.timeout(180_000), alternate = new URL(url), limit = 256 * 1024 * 1024
  alternate.searchParams.set('download', '1')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const api = attempt === 2 && assetId !== undefined
      const source = api ? `https://api.github.com/repos/microsoft/sqltoolsservice/releases/assets/${assetId}` : attempt === 0 ? url : alternate.href
      const response = await fetch(source, { signal, headers: { 'User-Agent': 'Varia-SQL-Manager-build', ...(api ? { Accept: 'application/octet-stream' } : {}) } })
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadError(`SQL Tools Service download failed (HTTP ${response.status}).`, response.status === 408 || response.status === 429 || response.status >= 500 && response.status <= 599)
      }
      const length = response.headers.get('content-length')
      if (length !== null && /^\d+$/.test(length) && Number(length) > limit) {
        await response.body.cancel().catch(() => {})
        throw new DownloadError('SQL Tools Service archive exceeds the download limit.')
      }
      let bytes = 0
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length
        callback(bytes > limit ? new DownloadError('SQL Tools Service archive exceeds the download limit.') : null, chunk)
      } }), createWriteStream(destination, { flags: 'wx' }), { signal })
      return
    } catch (error) {
      await rm(destination, { force: true })
      if (attempt === 2 || signal.aborted || !retryableDownload(error)) throw error
    }
  }
}
async function extract(archive, folder) {
  const { stdout } = await exec('tar', ['-tf', archive], { maxBuffer: 8 * 1024 * 1024 })
  safeArchiveEntries(stdout)
  await exec('tar', ['-xf', archive, '-C', folder], { maxBuffer: 1024 * 1024 })
}
/** An explicit local archive is useful for offline builds; its digest must still match the checked-in manifest. */
export async function prepareSqlToolsService({ rid = hostRid(), root = projectRoot, archivePath, manifest = sqlToolsManifest,
  downloadArchive = downloadSqlToolsArchive, extractArchive = extract } = {}) {
  if (!Object.hasOwn(manifest.platforms, rid)) throw new Error(`Unsupported SQL Tools Service target: ${rid}.`)
  if (await sha256(join(root, manifest.license.file)) !== manifest.license.sha256) throw new Error('The pinned SQL Tools Service license failed verification.')
  const artifacts = join(root, 'artifacts'), output = inside(artifacts, join(artifacts, 'sqltools-service', rid))
  if (!(await sqlToolsServiceProblems(output, rid, manifest)).length) return output
  const entry = manifest.platforms[rid], downloads = join(artifacts, 'sqltools-service-downloads')
  await mkdir(downloads, { recursive: true })
  const archive = archivePath ? resolve(archivePath) : inside(downloads, join(downloads, entry.archive))
  if (!archivePath) {
    let valid = false
    try { valid = await sha256(archive) === entry.sha256 } catch { /* First preparation downloads it. */ }
    if (!valid) {
      const partial = inside(downloads, `${archive}.${process.pid}.partial`)
      try {
        await downloadArchive(archiveUrl(rid, manifest), partial, entry.assetId)
        if (await sha256(partial) !== entry.sha256) throw new Error('SQL Tools Service archive SHA-256 does not match the pinned release.')
        await rm(archive, { force: true }); await renamePreparedArtifact(partial, archive)
      } finally { await rm(partial, { force: true }) }
    }
  }
  if (await sha256(archive) !== entry.sha256) throw new Error('SQL Tools Service archive SHA-256 does not match the pinned release.')
  const staging = inside(artifacts, `${output}.staging-${process.pid}`)
  await removeGenerated(artifacts, staging)
  await mkdir(staging, { recursive: true })
  try {
    await extractArchive(archive, staging)
    await copyFile(join(root, manifest.license.file), join(staging, 'LICENSE.SqlToolsService.txt'))
    await writeFile(join(staging, markerName), JSON.stringify({ version: manifest.version, rid, archiveSha256: entry.sha256, files: await inventory(staging) }, null, 2) + '\n')
    const problems = await sqlToolsServiceProblems(staging, rid, manifest)
    if (problems.length) throw new Error(problems.join(' '))
    await removeGenerated(artifacts, output)
    await renamePreparedArtifact(staging, output)
    return output
  } finally { await removeGenerated(artifacts, staging) }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = process.argv.slice(2), options = {}
    let check = false
    while (args.length) {
      const flag = args.shift()
      if (flag === '--rid' || flag === '--archive') {
        const value = args.shift()
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`)
        options[flag === '--rid' ? 'rid' : 'archivePath'] = value
      } else if (flag === '--check') check = true
      else throw new Error(`Unknown SQL Tools Service preparation option: ${flag}.`)
    }
    const rid = options.rid ?? hostRid()
    if (check) {
      const problems = await sqlToolsServiceProblems(join(projectRoot, 'artifacts', 'sqltools-service', rid), rid)
      if (problems.length) throw new Error(problems.join(' '))
    } else await prepareSqlToolsService(options)
    console.log(`SQL Tools Service ${sqlToolsManifest.version} verified for ${rid}.`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
