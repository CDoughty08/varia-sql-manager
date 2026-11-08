import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { remoteDebuggingSwitches, sandboxRefusal, stripRemoteDebugging } from '../src/main/sandbox-guard'

const require = createRequire(import.meta.url)

describe('Chromium sandbox guard', () => {
  it('refuses a packaged build started with --no-sandbox on every platform, with the Linux remedy on Linux', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(sandboxRefusal({ packaged: true, platform, noSandbox: false })).toBeNull()
      expect(sandboxRefusal({ packaged: true, platform, noSandbox: true })).toMatch(/will not run without it/)
      // Unpackaged runs keep --no-sandbox for smoke tests as root.
      expect(sandboxRefusal({ packaged: false, platform, noSandbox: true })).toBeNull()
    }
    expect(sandboxRefusal({ packaged: true, platform: 'linux', noSandbox: true })).toMatch(/AppArmor/)
    expect(sandboxRefusal({ packaged: true, platform: 'win32', noSandbox: true })).not.toMatch(/AppArmor/)
  })

  it('strips and refuses remote debugging in packaged builds only', () => {
    const commandLine = (switches: string[]) => {
      const present = new Set(switches)
      return { present, hasSwitch: (name: string) => present.has(name), removeSwitch: (name: string) => { present.delete(name) } }
    }
    for (const name of remoteDebuggingSwitches) {
      const packaged = commandLine([name, 'lang'])
      expect(stripRemoteDebugging(packaged, true)).toBe(true)
      expect([...packaged.present]).toEqual(['lang'])
      const unpackaged = commandLine([name])
      expect(stripRemoteDebugging(unpackaged, false)).toBe(false)
      expect([...unpackaged.present]).toEqual([name])
    }
    expect(stripRemoteDebugging(commandLine(['lang']), true)).toBe(false)
    expect(remoteDebuggingSwitches).toEqual(['remote-debugging-port', 'remote-debugging-pipe'])
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(sandboxRefusal({ packaged: true, platform, noSandbox: false, remoteDebugging: true })).toMatch(/remote debugging/)
      expect(sandboxRefusal({ packaged: false, platform, noSandbox: false, remoteDebugging: true })).toBeNull()
    }
  })

  it('strips remote debugging as main loads, before Chromium starts the DevTools handler', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const strip = main.indexOf('const remoteDebugging = stripRemoteDebugging(app.commandLine, app.isPackaged)')
    const lastImport = main.lastIndexOf('\nimport ')
    expect(strip).toBeGreaterThan(lastImport)
    // Nothing runs between the imports and the strip.
    expect(main.slice(main.indexOf('\n', lastImport + 1), strip).split('\n').filter(line => line.trim() && !line.trim().startsWith('//'))).toEqual([])
  })

  it('runs before main registers the app protocol or opens a window', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const ready = main.indexOf('app.whenReady().then(async () => {')
    const guard = main.indexOf("sandboxRefusal({ packaged: app.isPackaged, platform: process.platform, noSandbox: app.commandLine.hasSwitch('no-sandbox'), remoteDebugging })")
    expect(ready).toBeGreaterThan(0)
    expect(guard).toBeGreaterThan(ready)
    expect(guard).toBeLessThan(main.indexOf('protocol.handle(appScheme', ready))
    expect(main.slice(guard, main.indexOf('protocol.handle(appScheme', ready))).toMatch(/app\.exit\(1\)\s+return/)
  })

  it('is needed: the AppImage launcher adds --no-sandbox by itself, so the desktop entry must not add it too', () => {
    // electron-builder 26.18's AppRun falls back to --no-sandbox when `unshare -Ur true` fails (GHSA-7g7r-gx96-252g's release).
    const { generateAppRunScript } = require('app-builder-lib/out/targets/appimage/appImageUtil.js')
    expect(generateAppRunScript({ ProductName: 'Varia SQL Manager', ExecutableName: 'varia-sql-manager', DesktopFileName: 'varia-sql-manager.desktop', ResourceName: 'varia-sql-manager' })).toMatch(/NO_SANDBOX=\(--no-sandbox\)/)
    // Its default desktop entry is `AppRun --no-sandbox %U`, which the guard would refuse on every launch.
    expect(readFileSync('electron-builder.yml', 'utf8')).toMatch(/^linux:\n(?: {2}.*\n)*? {2}executableArgs: \[\]$/m)
  })
})
