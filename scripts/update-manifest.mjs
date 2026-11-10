// Writes the update manifests for a release's packaged files, which the release job uploads with them. Varia's updater
// (src/main/updater.ts) reads varia-update-v2.json from GitHub's latest-release link and installs only a file whose size
// and SHA-512 match it. Builds up to 0.7.0 read varia-update.json and refuse one with a kind or field they do not know,
// so that file keeps its first shape: schema 1, and only the kinds those builds know.
// Usage: node scripts/update-manifest.mjs <assets folder> <version>
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The updater's bounds (src/shared/updates.ts's updateLimits, and the schema builds up to 0.7.0 shipped). A file
// outside them would be left out by current builds and would make older ones refuse the whole manifest, so a release
// with one fails here, in the packaging job, instead.
export const manifestLimits = { assetBytes: 1_073_741_824, nameChars: 128, assets: 64, legacyAssets: 32 }

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const archOf = { x64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64' }

/** The kind and architecture of one of electron-builder's file names (electron-builder.yml), or undefined. */
export function classifyAsset(name, version) {
  const prefix = `^Varia-SQL-Manager-${escape(version)}-`
  const rules = [
    [new RegExp(`${prefix}Windows-(x64|arm64)-Setup\\.exe$`), 'win-setup'],
    [new RegExp(`${prefix}Windows-(x64|arm64)-Portable\\.exe$`), 'win-portable'],
    [new RegExp(`${prefix}win-(x64|arm64)\\.zip$`), 'win-zip'],
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
    if (info.size < 1 || info.size > manifestLimits.assetBytes) throw new Error(`${name} is ${info.size} bytes: the updater downloads files of 1 byte to 1 GiB`)
    if (name.length > manifestLimits.nameChars) throw new Error(`${name} is longer than ${manifestLimits.nameChars} characters`)
    assets.push({ name, ...kind, size: info.size, sha512: await sha512(path) })
  }
  if (!assets.length) throw new Error(`No release files for ${version} in ${folder}`)
  if (assets.length > manifestLimits.assets) throw new Error(`${assets.length} release files: the updater reads at most ${manifestLimits.assets}`)
  return { schema: 2, version, releasedAt, assets }
}

/** The kinds builds up to 0.7.0 accept (their manifest schema is strict); src/shared/updates.ts's legacyAssetKinds. */
export const legacyKinds = ['win-setup', 'win-portable', 'linux-appimage', 'mac-dmg', 'mac-zip']

/** The same release as builds up to 0.7.0 read it, or undefined when it has none of the files they know. */
export function legacyManifest(manifest) {
  const assets = manifest.assets.filter(asset => legacyKinds.includes(asset.kind)).map(({ name, kind, arch, size, sha512 }) => ({ name, kind, arch, size, sha512 }))
  if (assets.length > manifestLimits.legacyAssets) throw new Error(`${assets.length} release files for builds up to 0.7.0, which read at most ${manifestLimits.legacyAssets}`)
  return assets.length ? { schema: 1, version: manifest.version, releasedAt: manifest.releasedAt, assets } : undefined
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [folder, version] = process.argv.slice(2)
  if (!folder || !version) throw new Error('Usage: node scripts/update-manifest.mjs <assets folder> <version>')
  const manifest = await buildManifest(folder, version.replace(/^v/, ''))
  await writeFile(join(folder, 'varia-update-v2.json'), JSON.stringify(manifest, null, 2) + '\n')
  const legacy = legacyManifest(manifest)
  if (legacy) await writeFile(join(folder, 'varia-update.json'), JSON.stringify(legacy, null, 2) + '\n')
  console.log(`varia-update-v2.json: ${manifest.assets.map(asset => `${asset.kind} ${asset.arch}`).join(', ')}`)
}
