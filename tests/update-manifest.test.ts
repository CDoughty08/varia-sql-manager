import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error The release script is plain JavaScript without declarations.
import { buildManifest, classifyAsset } from '../scripts/update-manifest.mjs'
import { assetFor, updateManifestSchema, type InstallKind } from '../src/shared/updates'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'varia-update-manifest-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

// The release job's expected files (release.yml's Check release assets), with $version filled in.
const releaseNames = (version: string) => [...new Set([...readFileSync('.github/workflows/release.yml', 'utf8').matchAll(/"dist\/(Varia-SQL-Manager-\$version-[^"]+)"/g)].map(match => match[1]!.replace('$version', version)))]

describe('update manifest', () => {
  it('recognises every file the release job packages', () => {
    const names = releaseNames('1.2.3')
    expect(names.length).toBeGreaterThanOrEqual(7)
    for (const name of names) expect(classifyAsset(name, '1.2.3'), name).toBeDefined()
    expect(classifyAsset('Varia-SQL-Manager-1.2.3-linux-x86_64.AppImage', '1.2.3')).toEqual({ kind: 'linux-appimage', arch: 'x64' })
    expect(classifyAsset('Varia-SQL-Manager-1.2.2-linux-x86_64.AppImage', '1.2.3')).toBeUndefined()
    expect(classifyAsset('Varia-SQL-Manager-1.2.3-Windows-x64-Setup.exe.blockmap', '1.2.3')).toBeUndefined()
  })
  it('names the electron-builder artifacts the updater picks for each build', () => {
    const builder = readFileSync('electron-builder.yml', 'utf8')
    expect(builder).toContain('artifactName: Varia-SQL-Manager-${version}-Windows-x64-Setup.${ext}')
    expect(builder).toContain('artifactName: Varia-SQL-Manager-${version}-Windows-x64-Portable.${ext}')
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
    const kinds: [InstallKind, string, string][] = [['nsis', 'x64', 'Windows-x64-Setup.exe'], ['portable', 'x64', 'Windows-x64-Portable.exe'], ['appimage', 'x64', 'linux-x86_64.AppImage'], ['dmg', 'arm64', 'mac-arm64.dmg'], ['dmg', 'x64', 'mac-x64.dmg']]
    for (const [kind, arch, suffix] of kinds) {
      const asset = assetFor(parsed, kind, arch)!
      expect(asset.name).toBe(`Varia-SQL-Manager-1.2.3-${suffix}`)
      expect(asset.size).toBe(Buffer.byteLength(files[asset.name]!))
      expect(asset.sha512).toBe(createHash('sha512').update(files[asset.name]!).digest('base64'))
    }
  })
  it('refuses a folder without release files, and a version that is not one', async () => {
    await expect(buildManifest(dir, '1.2.3')).rejects.toThrow('No release files')
    await expect(buildManifest(dir, 'latest')).rejects.toThrow('Not a release version')
  })
})
