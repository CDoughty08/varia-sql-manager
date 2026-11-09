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
  const entry = manifest.platforms[rid]
  if (!entry || marker.version !== manifest.version || marker.rid !== rid || marker.archiveSha256 !== entry.sha256)
    return ['SQL Tools Service does not match the pinned version and target.']
  if (!Array.isArray(marker.files) || marker.files.length < 3 || marker.files.length > 8192) return ['SQL Tools Service file inventory is invalid.']
  let actual
  try { actual = new Map((await inventory(folder)).map(file => [file.path, file.sha256])) }
  catch { return ['SQL Tools Service distribution contains missing, unreadable or non-regular files.'] }
  for (const required of [executableName(rid), 'MicrosoftSqlToolsServiceLayer.dll', 'MicrosoftSqlToolsServiceLayer.runtimeconfig.json', 'Notice.txt', 'LICENSE.SqlToolsService.txt'])
    if (!marker.files.some(file => file.path === required)) problems.push(`SQL Tools Service is missing ${required}.`)
  for (const file of marker.files) {
    try {
      safeArchiveEntries(file.path)
      inside(folder, join(folder, file.path))
      if (actual.get(file.path) !== file.sha256) problems.push(`SQL Tools Service file failed verification: ${file.path}.`)
    } catch { problems.push(`SQL Tools Service file is missing or invalid: ${String(file.path)}.`) }
  }
  const expected = new Set(marker.files.map(file => file.path))
  for (const file of actual.keys()) if (!expected.has(file)) problems.push(`SQL Tools Service contains an unexpected file: ${file}.`)
  return problems
}
async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000), headers: { 'User-Agent': 'Varia-SQL-Manager-build' } })
  if (!response.ok || !response.body) throw new Error(`SQL Tools Service download failed (HTTP ${response.status}).`)
  let bytes = 0
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length
    callback(bytes > 256 * 1024 * 1024 ? new Error('SQL Tools Service archive exceeds the download limit.') : null, chunk)
  } }), createWriteStream(destination, { flags: 'wx' }))
}
async function extract(archive, folder) {
  const { stdout } = await exec('tar', ['-tf', archive], { maxBuffer: 8 * 1024 * 1024 })
  safeArchiveEntries(stdout)
  await exec('tar', ['-xf', archive, '-C', folder], { maxBuffer: 1024 * 1024 })
}
/** An explicit local archive is useful for offline builds; its digest must still match the checked-in manifest. */
export async function prepareSqlToolsService({ rid = hostRid(), root = projectRoot, archivePath, manifest = sqlToolsManifest,
  downloadArchive = download, extractArchive = extract } = {}) {
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
        await downloadArchive(archiveUrl(rid, manifest), partial)
        if (await sha256(partial) !== entry.sha256) throw new Error('SQL Tools Service archive SHA-256 does not match the pinned release.')
        await rm(archive, { force: true }); await rename(partial, archive)
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
    await rename(staging, output)
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
