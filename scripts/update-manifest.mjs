// Writes the update manifest (varia-update.json) for a release's packaged files, which the release job uploads with them.
// Varia's updater (src/main/updater.ts) reads it from GitHub's latest-release link and installs only a file whose size and
// SHA-512 match it. Usage: node scripts/update-manifest.mjs <assets folder> <version>
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const archOf = { x64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64' }

/** The kind and architecture of one of electron-builder's file names (electron-builder.yml), or undefined. */
export function classifyAsset(name, version) {
  const prefix = `^Varia-SQL-Manager-${escape(version)}-`
  const rules = [
    [new RegExp(`${prefix}Windows-(x64|arm64)-Setup\\.exe$`), 'win-setup'],
    [new RegExp(`${prefix}Windows-(x64|arm64)-Portable\\.exe$`), 'win-portable'],
    [new RegExp(`${prefix}linux-(x86_64|aarch64|arm64)\\.AppImage$`), 'linux-appimage'],
    [new RegExp(`${prefix}mac-(arm64|x64)\\.dmg$`), 'mac-dmg'],
    [new RegExp(`${prefix}mac-(arm64|x64)\\.zip$`), 'mac-zip']
  ]
  for (const [pattern, kind] of rules) {
    const match = pattern.exec(name)
    if (match) return { kind, arch: archOf[match[1]] }
  }
  return undefined
}

const sha512 = path => new Promise((resolve, reject) => {
  const hash = createHash('sha512')
  createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('base64')))
})

/** The manifest for the files in `folder` that belong to `version`; it refuses a release with none, or two for one slot. */
export async function buildManifest(folder, version, releasedAt = new Date().toISOString()) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Not a release version: ${version}`)
  const assets = []
  for (const name of (await readdir(folder)).sort()) {
    const kind = classifyAsset(name, version)
    if (!kind) continue
    const path = join(folder, name), info = await stat(path)
    if (!info.isFile()) continue
    if (assets.some(asset => asset.kind === kind.kind && asset.arch === kind.arch)) throw new Error(`Two ${kind.kind} ${kind.arch} files: ${name}`)
    assets.push({ name, ...kind, size: info.size, sha512: await sha512(path) })
  }
  if (!assets.length) throw new Error(`No release files for ${version} in ${folder}`)
  return { schema: 1, version, releasedAt, assets }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [folder, version] = process.argv.slice(2)
  if (!folder || !version) throw new Error('Usage: node scripts/update-manifest.mjs <assets folder> <version>')
  const manifest = await buildManifest(folder, version.replace(/^v/, ''))
  await writeFile(join(folder, 'varia-update.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`varia-update.json: ${manifest.assets.map(asset => `${asset.kind} ${asset.arch}`).join(', ')}`)
}
