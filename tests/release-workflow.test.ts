import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { backendSpawnSpec } from '../src/main/backend/spawn-spec'

// Pull request runs compete for GitHub's 20 concurrent jobs (5 macOS) across every open pull request, so the queue, not the
// jobs, set most of a run's wall time (docs/ci.md). These checks keep the cost a pull request push adds outside ci.yml small:
// packaging only when a pull request changes what packaging reads, every superseded run cancelled, and no Intel macOS
// packaging and no unused uploads before a tag.

const dir = '.github/workflows'
const text = (name: string) => readFileSync(`${dir}/${name}`, 'utf8')
const triggers = (yaml: string) => yaml.slice(yaml.indexOf('\non:'), yaml.search(/\n(concurrency|permissions|env|jobs):/))
const release = text('release.yml'), pack = text('package.yml')
const releasePaths = [...triggers(release).matchAll(/^ {6}- (\S+)$/gm)].map(match => match[1])

describe('Release builds', () => {
  it('cancels the superseded run of every workflow a pull request triggers, but never a tag or a manual run', () => {
    for (const name of readdirSync(dir).filter(file => file.endsWith('.yml'))) {
      const yaml = text(name)
      if (!/^ {2}pull_request:/m.test(triggers(yaml))) continue
      expect(yaml, name).toMatch(/\nconcurrency:\n(?: {2}#.*\n)* {2}group: .*github\.event_name == 'pull_request'.*github\.ref.*github\.run_id/)
      expect(yaml, name).toMatch(/\n {2}cancel-in-progress: true\n/)
    }
  })
  it('packages every main push, tag and manual run, and a pull request only when it changes what packaging reads', () => {
    expect(triggers(release)).toMatch(/\n {2}push:\n {4}branches: \[main\]\n {4}tags: \['v\*'\]\n {2}schedule:\n {4}- cron: '[^']+'\n {2}workflow_dispatch:/)
    // Everything electron-builder, the fuses and the packaged smoke tests read, and nothing every pull request touches:
    // the smoke selectors (scripts/fixtures/ui.mjs) and main's index changed in a third of recent pull requests.
    for (const path of ['.github/workflows/release.yml', '.github/workflows/package.yml', 'electron-builder.yml', 'build/**', 'package-lock.json', 'scripts/packaged-smoke.mjs', 'scripts/packaged-contents.mjs', 'scripts/portable-smoke.mjs', 'scripts/windows-installer-smoke.ps1', 'scripts/update-manifest.mjs', 'src/main/app-protocol.ts', 'src/main/backend/spawn-spec.ts', 'src/main/update-install.ts', 'src/main/update-staging.ts', 'backend/Varia.Updater/**', 'scripts/appimage-check.mjs']) expect(releasePaths).toContain(path)
    expect(releasePaths).toContain('src/main/backend/sqltools-runtime.ts')
    expect(releasePaths).toContain('scripts/prepare-electron.mjs')
    for (const path of releasePaths) expect(path, path).not.toMatch(/^(src\/\*\*|src\/main\/index\.ts|scripts\/fixtures|package\.json|tests\/)/)
  })
  it('adds at most three jobs and one macOS job to a pull request push, and packages Intel macOS only for tags, manual runs and weekly', () => {
    const matrix = release.slice(release.indexOf('  build:\n'), release.indexOf('  build-intel:\n'))
    const runners = [...matrix.matchAll(/- runner: (\S+)/g)].map(match => match[1])
    expect(runners.length).toBeLessThanOrEqual(3)
    expect(runners.filter(runner => runner.startsWith('macos')).length).toBeLessThanOrEqual(1)
    expect(runners).not.toContain('macos-15-intel')
    const intel = release.slice(release.indexOf('  build-intel:\n'), release.indexOf('  release:\n'))
    expect(intel).toMatch(/runner: macos-15-intel/)
    // Weekly, so an x64-only break (an Electron or runner image change) shows before the tag it would block; the other
    // packages, which every main push builds, skip that run.
    expect(intel).toMatch(/\n {4}if: startsWith\(github\.ref, 'refs\/tags\/'\) \|\| github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'\n/)
    expect(matrix).toMatch(/\n {4}if: github\.event_name != 'schedule'\n/)
    expect(release).toMatch(/needs: \[build, build-intel\]/)
  })
  it('keeps the packaged checks, and leaves out the work CI already did or nobody uses', () => {
    // Each packaged check runs on every packaging run: a condition on the ref or the event would quietly drop it before tags.
    const steps = pack.slice(pack.indexOf('\n    steps:\n')).split(/\n {6}- /).slice(1)
    for (const marker of ['scripts/packaged-smoke.mjs', 'scripts/portable-smoke.mjs', 'windows-installer-smoke.ps1', 'scripts/update-manifest.mjs dist', 'Check release assets', 'Package application', 'Publish self-contained backend', 'Publish update helper', 'Prepare pinned SQL Tools Service']) {
      const step = steps.find(candidate => candidate.includes(marker))
      expect(step, marker).toBeDefined()
      expect(/\n {8}if: (.*)/.exec(step!)?.[1] ?? '', marker).not.toMatch(/github\.ref|github\.event_name/)
    }
    expect(pack).toMatch(/- name: Type check\n {8}if: startsWith\(github\.ref, 'refs\/tags\/'\)\n/)
    expect(pack).toMatch(/- name: Upload release assets\n {8}if: startsWith\(github\.ref, 'refs\/tags\/'\) \|\| github\.event_name == 'workflow_dispatch'\n/)
  })
  // The installed Windows build updates by unpacking the release's archive with the helper in its resources: a release
  // without either, or a helper built after packaging, would leave every copy on the installer.
  it('publishes the update helper before packaging, and releases the Windows archive with the installers', () => {
    expect(pack.indexOf('- name: Publish update helper')).toBeGreaterThan(-1)
    expect(pack.indexOf('- name: Publish update helper')).toBeLessThan(pack.indexOf('- name: Package application'))
    expect(pack).toMatch(/dotnet publish backend\/Varia\.Updater\/Varia\.Updater\.csproj -c Release -r \$\{\{ inputs\.rid \}\} -o artifacts\/updater\n/)
    expect(pack).toContain('"dist/Varia-SQL-Manager-$version-win-x64.zip", "dist/win-unpacked/resources/updater/Varia.Updater.exe"')
    const windows = release.slice(release.indexOf('rid: win-x64'), release.indexOf('- runner: ubuntu'))
    expect(windows).toMatch(/target: --win nsis portable zip --x64\n/)
    expect(windows).toMatch(/asset: \|\n {14}dist\/\*\.exe\n {14}dist\/\*\.zip\n/)
    // The installer smoke stages and swaps the archive, compares the result with the packaged files, then recovers.
    // It also has the helper refuse a folder that is not the installation's staging folder, and answer what main asks.
    expect(readFileSync('scripts/windows-installer-smoke.ps1', 'utf8')).toMatch(/\$code -ne 2 -or \(Test-Path -LiteralPath \$elsewhere\)[\s\S]*'check', '--sha512'[\s\S]*\$code -ne 3[\s\S]*'stage', '--archive'[\s\S]*AreAccessRulesProtected[\s\S]*'swap', '--pid'[\s\S]*Assert-Application 'swapped'[\s\S]*-ArgumentList 'recover'[\s\S]*Assert-Application 'recovered'/)
    // Uninstalling takes the staging folder with it: the uninstaller asks the helper, before the application's files go,
    // and the installer smoke uninstalls a copy with a release staged.
    expect(readFileSync('build/installer.nsh', 'utf8')).toMatch(/!macro customUnInstall\n {2}IfFileExists "\$INSTDIR\\resources\\updater\\Varia\.Updater\.exe" 0 varia_staging_done\n {4}ExecWait '"\$INSTDIR\\resources\\updater\\Varia\.Updater\.exe" uninstall --install "\$INSTDIR"'\n/)
    expect(readFileSync('scripts/windows-installer-smoke.ps1', 'utf8')).toMatch(/'\/S', '\/currentuser', "_\?=\$installDir"[\s\S]*Test-Path -LiteralPath \$exe[\s\S]*Test-Path -LiteralPath \$root\) \{ throw/)
    // electron-builder only warns about a missing extraResources folder: packaging refuses instead.
    const { updaterProblem } = createRequire(import.meta.url)('../build/updater-check.cjs')
    expect(readFileSync('build/sqltools-service-check.cjs', 'utf8')).toMatch(/updaterProblem\(context\.electronPlatformName, context\.packager\.projectDir\)\n {2}if \(problem\) throw new Error\(problem\)/)
    expect(updaterProblem('win32', join('artifacts', 'no-such-project'))).toMatch(/dotnet publish backend\/Varia\.Updater/)
    expect(updaterProblem('linux', join('artifacts', 'no-such-project'))).toBeNull()
    expect(updaterProblem('darwin', join('artifacts', 'no-such-project'))).toBeNull()
    const project = readFileSync('backend/Varia.Updater/Varia.Updater.csproj', 'utf8')
    expect(project).toContain('<PublishAot Condition="\'$(RuntimeIdentifier)\' != \'\'">true</PublishAot>')
    expect(project).toContain('<TreatWarningsAsErrors>true</TreatWarningsAsErrors>')
  })
  // What the docs say about packaging must match the workflow: the weekly Intel run, and the paths filter's 300-file limit.
  it('documents the weekly Intel run and the paths filter\'s 300-file limit', () => {
    const ci = readFileSync('docs/ci.md', 'utf8').replace(/\n\s*/g, ' ')
    expect(ci).toContain('Intel macOS packages only for tags, manual runs and a weekly scheduled run on main')
    for (const [name, doc] of [['release.yml', release.replace(/\n# /g, ' ')], ['docs/ci.md', ci]]) expect(doc, name).toMatch(/first 300/)
    // Unreachable.Source is a malformed pipe address on purpose (a well-formed missing pipe crashed offline-stress copies).
    for (const file of ['docs/ci.md', 'backend/Varia.Backend.Tests/Unreachable.cs', 'tests/idle-waits.test.ts']) expect(readFileSync(file, 'utf8'), file).not.toMatch(/missing named pipe/)
  })
  // Packaged main starts the backend from resources/<extraResources' to:>; a rename on one side only broke the packaged
  // smoke test on the next main push, so it fails npm run check on every pull request instead.
  it('starts the packaged backend from the folder electron-builder copies it to', () => {
    const builder = readFileSync('electron-builder.yml', 'utf8')
    const to = /\n {2}- from: artifacts\/release-backend\n {4}to: (\S+)\n/.exec(builder)?.[1]
    expect(to).toBeDefined()
    const resourcesPath = join('opt', 'varia', 'resources')
    for (const [platform, exe] of [['win32', 'Varia.Backend.exe'], ['linux', 'Varia.Backend'], ['darwin', 'Varia.Backend']] as const) {
      expect(backendSpawnSpec({ packaged: true, root: 'app', resourcesPath, platform, smokeTest: false }).command, platform).toBe(join(resourcesPath, to!, exe))
    }
  })
})
