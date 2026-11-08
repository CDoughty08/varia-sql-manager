import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { sandboxRefusal } from '../src/main/sandbox-guard'

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

  it('runs before main registers the app protocol or opens a window', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const ready = main.indexOf('app.whenReady().then(async () => {')
    const guard = main.indexOf("sandboxRefusal({ packaged: app.isPackaged, platform: process.platform, noSandbox: app.commandLine.hasSwitch('no-sandbox') })")
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
