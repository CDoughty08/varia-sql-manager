import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// The backend lists the release RIDs so packages.lock.json covers each RID-specific publish (package.yml restores it
// locked). That list once made every plain restore (npm run check, npm run dev, each CI job) download 12 runtime and
// apphost packs, about 257 MB, for platforms the build never targets (#300).

const project = 'backend/Varia.Backend/Varia.Backend.csproj'
const runtimePack = /^Microsoft\.(NETCore|AspNetCore|WindowsDesktop)\.App\.(Runtime|Host|Crossgen2)\./

/** The packages a restore would download besides the lock file's: NuGet writes these to project.assets.json's downloadDependencies. */
function packageDownloads(...properties: string[]): string[] {
  const output = execFileSync('dotnet', ['msbuild', project, '-nologo', '-t:CollectPackageDownloads', '-getItem:PackageDownload', ...properties], { encoding: 'utf8' })
  const { Items } = JSON.parse(output.slice(output.indexOf('{'))) as { Items: { PackageDownload: { Identity: string }[] } }
  return Items.PackageDownload.map(item => item.Identity)
}

describe('backend restore', () => {
  it('downloads no runtime or apphost packs for a plain restore', () => {
    expect(packageDownloads().filter(name => runtimePack.test(name))).toEqual([])
  }, 120_000)
  it('still downloads the target runtime and the ReadyToRun compiler for a RID-specific publish', () => {
    const downloads = packageDownloads('-p:RuntimeIdentifier=linux-x64', '-p:SelfContained=true')
    expect(downloads).toContain('Microsoft.NETCore.App.Runtime.linux-x64')
    expect(downloads.some(name => name.startsWith('Microsoft.NETCore.App.Crossgen2.'))).toBe(true)
  }, 120_000)
  it('keeps the lock file\'s RID sections in step with the project\'s, so the locked RID-specific restore stays valid', () => {
    const rids = /<RuntimeIdentifiers>([^<]+)<\/RuntimeIdentifiers>/.exec(readFileSync(project, 'utf8'))?.[1].split(';')
    const lock = JSON.parse(readFileSync('backend/Varia.Backend/packages.lock.json', 'utf8')) as { dependencies: Record<string, unknown> }
    expect(Object.keys(lock.dependencies).sort()).toEqual(['net11.0', ...rids!.map(rid => `net11.0/${rid}`)].sort())
    expect(readFileSync('.github/workflows/package.yml', 'utf8')).toMatch(/dotnet publish backend\/Varia\.Backend\/Varia\.Backend\.csproj .*-r \$\{\{ inputs\.rid \}\} .*-p:RestoreLockedMode=true/)
  })
})
