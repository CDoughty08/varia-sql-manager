import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  it('publishes the same curated record as the app and refuses missing or mismatched tag notes', () => {
    expect(release).toContain('node scripts/release-notes.mjs "$RELEASE_TAG" release-notes.md')
    expect(release).toContain('args=(--verify-tag --notes-file release-notes.md)')
    expect(release).not.toContain('--generate-notes')
    expect(release.indexOf('- name: Prepare curated release notes')).toBeLessThan(release.indexOf('- name: Create release with curated notes'))
  })
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
    for (const path of ['.github/workflows/release.yml', '.github/workflows/package.yml', 'electron-builder.yml', 'build/**', 'package-lock.json', 'scripts/packaged-smoke.mjs', 'scripts/packaged-contents.mjs', 'scripts/package-prepare.mjs', 'scripts/portable-smoke.mjs', 'scripts/windows-installer-smoke.ps1', 'scripts/update-manifest.mjs', 'src/main/app-protocol.ts', 'src/main/backend/spawn-spec.ts', 'src/main/update-install.ts', 'src/main/update-staging.ts', 'backend/Varia.Updater/**', 'scripts/appimage-check.mjs']) expect(releasePaths).toContain(path)
    expect(releasePaths).toContain('src/main/backend/sqltools-runtime.ts')
    expect(releasePaths).toContain('scripts/prepare-electron.mjs')
    for (const path of releasePaths) expect(path, path).not.toMatch(/^(src\/\*\*|src\/main\/index\.ts|scripts\/fixtures|package\.json|tests\/)/)
  })
  it('keeps complete packaging on every main push so cancellation cannot discard unfinished code validation', () => {
    expect(triggers(release)).not.toContain('paths-ignore:')
    expect(release).not.toContain('  scope:')
    expect(release).not.toContain('needs.scope')
    expect(release).toContain("group: ${{ github.workflow }}-${{ (github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main')) && github.ref || github.run_id }}")
  })
  it('publishes tags only when both packaging jobs succeeded', () => {
    const publish = release.slice(release.indexOf('  release:\n'))
    expect(publish).toContain("if: ${{ !cancelled() && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/') && needs.build.result == 'success' && needs.build-intel.result == 'success' }}")
    expect(publish).toContain('needs: [build, build-intel]')
  })
  it('adds at most three jobs and one macOS job to a pull request push, and cross-builds Intel macOS on arm64 for tags, manual runs and weekly', () => {
    const matrix = release.slice(release.indexOf('  build:\n'), release.indexOf('  build-intel:\n'))
    const runners = [...matrix.matchAll(/- runner: (\S+)/g)].map(match => match[1])
    expect(runners.length).toBeLessThanOrEqual(3)
    expect(runners.filter(runner => runner.startsWith('macos')).length).toBeLessThanOrEqual(1)
    expect(runners).not.toContain('macos-15-intel')
    const intel = release.slice(release.indexOf('  build-intel:\n'), release.indexOf('  release:\n'))
    expect(intel).toMatch(/runner: macos-15\n/)
    expect(intel).toMatch(/rid: osx-x64\n/)
    // Weekly, so an x64-only break (an Electron or runner image change) shows before the tag it would block; the other
    // packages, which every main push builds, skip that run.
    expect(intel).toMatch(/\n {4}if: startsWith\(github\.ref, 'refs\/tags\/'\) \|\| github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'\n/)
    expect(matrix).toMatch(/\n {4}if: github\.event_name != 'schedule'\n/)
    expect(release).toMatch(/needs: \[build, build-intel\]/)
  })
  it('keeps the packaged checks, caches NuGet, and skips only unused non-tag archive compression and macOS DMG/ZIP', () => {
    // Each packaged check runs on every packaging run: a condition on the ref or the event would quietly drop it before tags.
    const steps = pack.slice(pack.indexOf('\n    steps:\n')).split(/\n {6}- /).slice(1)
    for (const marker of ['scripts/packaged-smoke.mjs', 'scripts/portable-smoke.mjs', 'windows-installer-smoke.ps1', 'Check release assets', 'Package application', 'scripts/package-prepare.mjs']) {
      const step = steps.find(candidate => candidate.includes(marker))
      expect(step, marker).toBeDefined()
      expect(/\n {8}if: (.*)/.exec(step!)?.[1] ?? '', marker).not.toMatch(/github\.ref|github\.event_name/)
    }
    expect(pack).toContain('cache: true\n          cache-dependency-path: backend/Varia.Backend/packages.lock.json')
    expect(pack).toContain('VARIA_PACKAGED_RID: ${{ inputs.rid }}')
    expect(pack).toContain('--config.compression=store')
    expect(pack).toContain('--mac dir --arm64')
    expect(pack).toMatch(/- name: Type check\n {8}if: startsWith\(github\.ref, 'refs\/tags\/'\)\n/)
    expect(pack).toMatch(/- name: Upload release assets\n {8}if: startsWith\(github\.ref, 'refs\/tags\/'\) \|\| github\.event_name == 'workflow_dispatch'\n/)
  })
  // The installed Windows build updates by unpacking the release's archive with the helper in its resources: a release
  // without either, or a helper built after packaging, would leave every copy on the installer.
  it('publishes the update helper before packaging, and releases the Windows archive with the installers', () => {
    const prepareScript = readFileSync('scripts/package-prepare.mjs', 'utf8')
    expect(pack.indexOf('scripts/package-prepare.mjs')).toBeGreaterThan(-1)
    expect(pack.indexOf('scripts/package-prepare.mjs')).toBeLessThan(pack.indexOf('- name: Package application'))
    expect(pack).toContain("node scripts/package-prepare.mjs --rid ${{ inputs.rid }} ${{ runner.os == 'Windows' && '--updater' || '' }}")
    expect(prepareScript).toContain('dotnet publish backend/Varia.Backend/Varia.Backend.csproj -c Release -r ${rid} --self-contained true -p:RestoreLockedMode=true -o artifacts/release-backend')
    expect(prepareScript).toContain('dotnet publish backend/Varia.Updater/Varia.Updater.csproj -c Release -r ${rid} -o artifacts/updater')
    expect(prepareScript).toContain('npm run sqltools:prepare -- --rid ${rid}')
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
    // The same for the backend: without its self-contained publish for the target, the app fails at launch (spawn ENOENT).
    const { backendFramework, backendProblem } = createRequire(import.meta.url)('../build/backend-check.cjs')
    expect(backendFramework('.')).toBe(JSON.parse(readFileSync('global.json', 'utf8')).sdk.version.split('.').slice(0, 2).join('.'))
    expect(readFileSync('build/sqltools-service-check.cjs', 'utf8')).toMatch(/const backend = backendProblem\(rid, context\.packager\.projectDir\)\n {2}if \(backend\) throw new Error\(backend\)\n(?:.*\n)*.*prepareSqlToolsService\(\{ rid,/)
    const project = mkdtempSync(join(tmpdir(), 'varia-backend-check-')), published = join(project, 'artifacts', 'release-backend')
    mkdirSync(join(project, 'backend', 'Varia.Backend'), { recursive: true })
    writeFileSync(join(project, 'backend', 'Varia.Backend', 'Varia.Backend.csproj'), '<TargetFramework>net11.0</TargetFramework>')
    const publish = (rid: string, selfContained: boolean, version = '11.0') => {
      mkdirSync(published, { recursive: true })
      writeFileSync(join(published, rid.startsWith('win-') ? 'Varia.Backend.exe' : 'Varia.Backend'), '')
      writeFileSync(join(published, 'Varia.Backend.deps.json'), JSON.stringify({ runtimeTarget: { name: `.NETCoreApp,Version=v${version}/${rid}` } }))
      writeFileSync(join(published, 'Varia.Backend.runtimeconfig.json'), JSON.stringify({ runtimeOptions: selfContained ? { includedFrameworks: [{ name: 'Microsoft.NETCore.App' }] } : { framework: { name: 'Microsoft.NETCore.App' } } }))
    }
    try {
      expect(backendProblem('osx-arm64', project)).toMatch(/not published \(artifacts\/release-backend\/Varia\.Backend\)\. Publish it for osx-arm64 first .*: node scripts\/package-prepare\.mjs --rid osx-arm64$/)
      publish('osx-x64', true)
      expect(backendProblem('osx-arm64', project)).toMatch(/is for osx-x64, not osx-arm64/)
      publish('osx-arm64', true, '10.0')
      expect(backendProblem('osx-arm64', project)).toMatch(/different build \(\.NETCoreApp,Version=v10\.0, not \.NET 11\.0\)/)
      publish('osx-arm64', false)
      expect(backendProblem('osx-arm64', project)).toMatch(/not self-contained/)
      publish('osx-arm64', true)
      expect(backendProblem('osx-arm64', project)).toBeNull()
      expect(backendProblem('win-x64', project)).toMatch(/Varia\.Backend\.exe/)
      writeFileSync(join(published, 'Varia.Backend.deps.json'), '{')
      expect(backendProblem('osx-arm64', project)).toMatch(/no readable Varia\.Backend\.deps\.json/)
      publish('osx-arm64', true)
      writeFileSync(join(project, 'backend', 'Varia.Backend', 'Varia.Backend.csproj'), '<TargetFrameworks>net11.0</TargetFrameworks>')
      expect(backendProblem('osx-arm64', project)).toMatch(/Could not read the \.NET version/)
    } finally { rmSync(project, { recursive: true, force: true }) }
    const updaterProject = readFileSync('backend/Varia.Updater/Varia.Updater.csproj', 'utf8')
    expect(updaterProject).toContain('<PublishAot Condition="\'$(RuntimeIdentifier)\' != \'\'">true</PublishAot>')
    expect(updaterProject).toContain('<TreatWarningsAsErrors>true</TreatWarningsAsErrors>')
  })
  // What the docs say about packaging must match the workflow: the weekly Intel run, and the paths filter's 3,000-file limit.
  it('documents the weekly Intel run and the paths filter\'s 3,000-file limit', () => {
    const ci = readFileSync('docs/ci.md', 'utf8').replace(/\n\s*/g, ' ')
    expect(ci).toContain('Intel macOS packages only for tags, manual runs and a weekly scheduled run on main')
    for (const [name, doc] of [['release.yml', release.replace(/\n# /g, ' ')], ['docs/ci.md', ci]]) expect(doc, name).toMatch(/first 3,000/)
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
