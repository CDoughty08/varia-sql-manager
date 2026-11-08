import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appRunExecutable, appRunProblems, parseReport, refusalText, searchPathProblems } from '../scripts/appimage-check.mjs'
import { sandboxRefusal } from '../src/main/sandbox-guard'

// The packaged smoke test runs dist/linux-unpacked, so nothing checked the AppImage's own launcher (#263). Release builds
// run scripts/appimage-check.mjs on the real AppImage; these checks hold its logic, and the AppRun the installed
// app-builder-lib generates, on every npm run check.
const require = createRequire(import.meta.url)
const builder = dirname(require.resolve('electron-builder/package.json'))
const appImageUtil = join(dirname(require.resolve('app-builder-lib/package.json', { paths: [builder] })), 'out/targets/appimage/appImageUtil.js')
const { generateAppRunScript } = require(appImageUtil) as { generateAppRunScript: (config: Record<string, unknown>) => string }
const appRun = generateAppRunScript({ ExecutableName: 'varia-sql-manager', ProductName: 'Varia SQL Manager', ProductFilename: 'Varia SQL Manager' })

describe('AppImage check', () => {
  it('refuses empty search-path components, a missing AppDir entry and a lost caller value', () => {
    const appDir = '/tmp/x/appdir'
    const good = { PATH: `${appDir}:${appDir}/usr/sbin:/usr/bin`, LD_LIBRARY_PATH: `${appDir}/usr/lib`, XDG_DATA_DIRS: `${appDir}/usr/share/:/usr/share/`, GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas` }
    expect(searchPathProblems(good, { PATH: '/usr/bin' }, appDir)).toEqual([])
    expect(searchPathProblems({ ...good, LD_LIBRARY_PATH: `${appDir}/usr/lib:` }, {}, appDir)).toEqual([expect.stringMatching(/LD_LIBRARY_PATH has an empty component/)])
    expect(searchPathProblems({ ...good, XDG_DATA_DIRS: `${appDir}/usr/share/::/usr/share/` }, {}, appDir)).toEqual([expect.stringMatching(/XDG_DATA_DIRS has an empty component/)])
    expect(searchPathProblems({ ...good, PATH: '/usr/bin' }, {}, appDir)).toEqual([expect.stringMatching(/PATH does not start with the AppDir/)])
    expect(searchPathProblems(good, { LD_LIBRARY_PATH: '/opt/lib' }, appDir)).toEqual([expect.stringMatching(/LD_LIBRARY_PATH lost \/opt\/lib/)])
    const { GSETTINGS_SCHEMA_DIR: _, ...missing } = good
    expect(searchPathProblems(missing, {}, appDir)).toEqual(['GSETTINGS_SCHEMA_DIR is not set'])
  })
  it('reads the executable AppRun starts and the stand-in\'s report', () => {
    expect(appRunExecutable(appRun)).toBe('varia-sql-manager')
    expect(() => appRunExecutable('#!/bin/sh\nexec ./app')).toThrow(/BIN=/)
    expect(parseReport('SET_PATH=/a:/b\nSET_LD_LIBRARY_PATH=\nARG=--x\nARG=a b\nnoise')).toEqual({ env: { PATH: '/a:/b', LD_LIBRARY_PATH: '' }, args: ['--x', 'a b'] })
  })
  // AppRun is a bash script; Windows runners have no /bin/sh for the stand-in, and Linux and macOS check it on every run.
  it.skipIf(process.platform === 'win32')('runs the installed AppRun with the search paths unset, empty and set and finds no empty component', () => {
    const work = mkdtempSync(join(tmpdir(), 'varia-apprun-'))
    try {
      expect(appRunProblems(appRun, work).problems).toEqual([])
    } finally { rmSync(work, { recursive: true, force: true }) }
    // The check would catch a launcher that appends without the ${VAR:+:${VAR}} guard.
    const unguarded = appRun.replace(/\$\{LD_LIBRARY_PATH:\+:\$\{LD_LIBRARY_PATH\}\}/, ':${LD_LIBRARY_PATH}')
    expect(unguarded).not.toBe(appRun)
    const again = mkdtempSync(join(tmpdir(), 'varia-apprun-'))
    try {
      expect(appRunProblems(unguarded, again).problems).toEqual(expect.arrayContaining([expect.stringMatching(/^unset: LD_LIBRARY_PATH has an empty component/), expect.stringMatching(/^empty: LD_LIBRARY_PATH has an empty component/)]))
    } finally { rmSync(again, { recursive: true, force: true }) }
  })
  it('waits for the refusal main prints before its error box', () => {
    expect(sandboxRefusal({ packaged: true, platform: 'linux', noSandbox: true })).toContain(refusalText)
    expect(readFileSync('src/main/index.ts', 'utf8')).toMatch(/if \(refusal\) \{\n(?: *\/\/.*\n)* *console\.error\(refusal\)\n *dialog\.showErrorBox/)
  })
  it('runs in Release builds\' Linux packaging job, on the AppImage itself', () => {
    const pack = readFileSync('.github/workflows/package.yml', 'utf8')
    const steps = pack.slice(pack.indexOf('\n    steps:\n')).split(/\n {6}- /).slice(1)
    for (const mode of ['inspect', 'refusal']) {
      const step = steps.find(candidate => candidate.includes(`scripts/appimage-check.mjs ${mode}`))
      expect(step, mode).toBeDefined()
      expect(/\n {8}if: (.*)/.exec(step!)?.[1], mode).toBe("runner.os == 'Linux'")
    }
    const smoke = steps.find(candidate => candidate.startsWith('name: Smoke test AppImage'))
    expect(smoke).toMatch(/APPIMAGE_EXTRACT_AND_RUN: '1'/)
    expect(smoke).toMatch(/VARIA_PACKAGED_EXECUTABLE: dist\/Varia-SQL-Manager-.*\.AppImage|VARIA_PACKAGED_EXECUTABLE=.*\.AppImage/)
    // Its resources sit in the squashfs, not beside it: the smoke script only launches it (the step failed reading dist/resources/app.asar).
    const script = readFileSync('scripts/packaged-smoke.mjs', 'utf8')
    const skipped = script.slice(script.indexOf('if (!appImage) {'), script.indexOf('\n}\n', script.indexOf('if (!appImage) {')))
    expect(script).toContain("const appImage = executable.endsWith('.AppImage')")
    for (const read of ['getCurrentFuseWire(', 'readAsar(', 'isReadyToRun(']) {
      expect(skipped, read).toContain(read)
      expect(script.split(read).length, read).toBe(2)
    }
    // The refusal launch restricts unprivileged user namespaces only for itself.
    const refusal = steps.find(candidate => candidate.includes('scripts/appimage-check.mjs refusal'))!
    expect(refusal).toMatch(/kernel\.apparmor_restrict_unprivileged_userns=1[\s\S]*kernel\.apparmor_restrict_unprivileged_userns=0/)
  })
})
