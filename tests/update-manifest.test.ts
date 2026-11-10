import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
// @ts-expect-error The release script is plain JavaScript without declarations.
import { buildManifest, classifyAsset, legacyKinds, legacyManifest, manifestLimits } from '../scripts/update-manifest.mjs'
import { truncate } from 'node:fs/promises'
import { assetFor, legacyAssetKinds, legacyManifestName, stagedAssetFor, updateLimits, updateManifestName, updateManifestSchema, type InstallKind } from '../src/shared/updates'

// The manifest schema as 0.7.0 shipped it, which every installed copy up to that version checks varia-update.json against.
const shippedSchema = z.strictObject({
  schema: z.literal(1),
  version: z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  releasedAt: z.iso.datetime().optional(),
  assets: z.array(z.strictObject({
    name: z.string().max(128).regex(/^Varia-SQL-Manager-[0-9A-Za-z._-]+\.(?:exe|AppImage|dmg|zip)$/),
    kind: z.enum(['win-setup', 'win-portable', 'linux-appimage', 'mac-dmg', 'mac-zip']),
    arch: z.enum(['x64', 'arm64']),
    size: z.int().min(1).max(1_073_741_824),
    sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/)
  })).max(32)
})

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'varia-update-manifest-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

// The packaging job's expected files (package.yml's Check release assets), with $version filled in.
const releaseNames = (version: string) => [...new Set([...readFileSync('.github/workflows/package.yml', 'utf8').matchAll(/"dist\/(Varia-SQL-Manager-\$version-[^"]+)"/g)].map(match => match[1]!.replace('$version', version)))]

describe('update manifest', () => {
  it('recognises every file the release job packages', () => {
    const names = releaseNames('1.2.3')
    expect(names.length).toBeGreaterThanOrEqual(8)
    expect(classifyAsset('Varia-SQL-Manager-1.2.3-win-x64.zip', '1.2.3')).toEqual({ kind: 'win-zip', arch: 'x64' })
    for (const name of names) expect(classifyAsset(name, '1.2.3'), name).toBeDefined()
    expect(classifyAsset('Varia-SQL-Manager-1.2.3-linux-x86_64.AppImage', '1.2.3')).toEqual({ kind: 'linux-appimage', arch: 'x64' })
    expect(classifyAsset('Varia-SQL-Manager-1.2.2-linux-x86_64.AppImage', '1.2.3')).toBeUndefined()
    expect(classifyAsset('Varia-SQL-Manager-1.2.3-Windows-x64-Setup.exe.blockmap', '1.2.3')).toBeUndefined()
  })
  it('names the electron-builder artifacts the updater picks for each build', () => {
    const builder = readFileSync('electron-builder.yml', 'utf8')
    expect(builder).toContain('artifactName: Varia-SQL-Manager-${version}-Windows-x64-Setup.${ext}')
    expect(builder).toContain('artifactName: Varia-SQL-Manager-${version}-Windows-x64-Portable.${ext}')
    // The archive takes the default name; the helper that unpacks it ships in the Windows packages' resources.
    expect(builder).toContain('artifactName: Varia-SQL-Manager-${version}-${os}-${arch}.${ext}')
    expect(builder).toMatch(/\n {2}target: \[nsis, portable, zip\]\n/)
    expect(builder).toMatch(/\n {4}- from: artifacts\/updater\n {6}to: updater\n {6}filter: \['Varia\.Updater\.exe'\]\n/)
  })
  it('writes a manifest the updater accepts, with each file\'s size and SHA-512', async () => {
    const files: Record<string, string> = {}
    for (const name of [...releaseNames('1.2.3'), 'unrelated.txt', 'Varia-SQL-Manager-1.2.3-Windows-x64-Setup.exe.blockmap']) {
      files[name] = `bytes of ${name}`
      await writeFile(join(dir, name), files[name]!)
    }
    const manifest = await buildManifest(dir, '1.2.3', '2026-11-04T00:00:00.000Z')
    const parsed = updateManifestSchema.parse(manifest)
    expect(parsed.assets).toHaveLength(releaseNames('1.2.3').length)
    expect(parsed.schema).toBe(2)
    expect(stagedAssetFor(parsed, 'nsis', 'x64')?.name).toBe('Varia-SQL-Manager-1.2.3-win-x64.zip')
    const kinds: [InstallKind, string, string][] = [['nsis', 'x64', 'Windows-x64-Setup.exe'], ['portable', 'x64', 'Windows-x64-Portable.exe'], ['appimage', 'x64', 'linux-x86_64.AppImage']]
    for (const [kind, arch, suffix] of kinds) {
      const asset = assetFor(parsed, kind, arch)!
      expect(asset.name).toBe(`Varia-SQL-Manager-1.2.3-${suffix}`)
      expect(asset.size).toBe(Buffer.byteLength(files[asset.name]!))
      expect(asset.sha512).toBe(createHash('sha512').update(files[asset.name]!).digest('base64'))
    }
  })
  // 0.7.0 and earlier refuse a manifest with a kind they do not know, and could then never update again.
  it('keeps the first manifest as the builds up to 0.7.0 accept it, without the archive', async () => {
    for (const name of releaseNames('1.2.3')) await writeFile(join(dir, name), `bytes of ${name}`)
    const manifest = await buildManifest(dir, '1.2.3', '2026-11-04T00:00:00.000Z')
    expect(shippedSchema.safeParse(manifest).success).toBe(false)
    const legacy = legacyManifest(manifest)
    expect(shippedSchema.parse(legacy)).toEqual(legacy)
    expect(legacy.assets).toEqual(manifest.assets.filter((asset: { kind: string }) => asset.kind !== 'win-zip'))
    expect(legacy.assets).toHaveLength(manifest.assets.length - 1)
    expect(legacy.assets.find((asset: { kind: string }) => asset.kind === 'win-setup')).toEqual(manifest.assets.find((asset: { kind: string }) => asset.kind === 'win-setup'))
    expect(legacyKinds).toEqual(legacyAssetKinds)
    expect(legacyManifest({ ...manifest, assets: manifest.assets.filter((asset: { kind: string }) => asset.kind === 'win-zip') })).toBeUndefined()
    // The script writes both, under the names the two generations of builds read.
    const script = readFileSync('scripts/update-manifest.mjs', 'utf8')
    expect(script).toContain(`join(folder, '${updateManifestName}')`)
    expect(script).toContain(`join(folder, '${legacyManifestName}')`)
    expect([updateManifestName, legacyManifestName]).toEqual(['varia-update-v2.json', 'varia-update.json'])
  })
  // A file the updater would leave out (or, up to 0.7.0, refuse the whole manifest over) stops the release instead.
  it('refuses a release file outside the updater\'s bounds', async () => {
    expect(manifestLimits).toEqual({ assetBytes: updateLimits.assetBytes, nameChars: updateLimits.nameChars, assets: updateLimits.assets, legacyAssets: 32 })
    const name = 'Varia-SQL-Manager-1.2.3-win-x64.zip'
    await writeFile(join(dir, name), '')
    await expect(buildManifest(dir, '1.2.3')).rejects.toThrow('0 bytes')
    // A sparse file: over the bound without writing a gigabyte.
    await truncate(join(dir, name), updateLimits.assetBytes + 1)
    await expect(buildManifest(dir, '1.2.3')).rejects.toThrow('1 GiB')
    // Refused by its size alone, before a gigabyte is hashed; a file within the bound goes through.
    await truncate(join(dir, name), 5)
    expect((await buildManifest(dir, '1.2.3')).assets).toMatchObject([{ name, size: 5 }])
    const asset = { name, kind: 'win-setup', arch: 'x64', size: 1, sha512: 'x' }
    expect(() => legacyManifest({ version: '1.2.3', assets: Array.from({ length: 33 }, () => asset) })).toThrow('at most 32')
  })
  it('refuses a folder without release files, and a version that is not one', async () => {
    await expect(buildManifest(dir, '1.2.3')).rejects.toThrow('No release files')
    await expect(buildManifest(dir, 'latest')).rejects.toThrow('Not a release version')
  })
})
