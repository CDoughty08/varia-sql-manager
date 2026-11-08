import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { packagedSmokeVariable, remoteDebuggingSwitches, sandboxRefusal, smokeDebuggingProfile, stripRemoteDebugging } from '../src/main/sandbox-guard'
import { lockedCipher } from '../src/main/secret-cipher'

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
    const strip = main.indexOf('const remoteDebugging = stripRemoteDebugging(app.commandLine, app.isPackaged, smokeProfile)')
    const lastImport = main.lastIndexOf('\nimport ')
    expect(strip).toBeGreaterThan(lastImport)
    // Nothing runs between the imports and the strip but the smoke allowance it reads.
    expect(main.slice(main.indexOf('\n', lastImport + 1), strip).split('\n').filter(line => line.trim() && !line.trim().startsWith('//')))
      .toEqual(["const smokeProfile = smokeDebuggingProfile({ packaged: app.isPackaged, env: process.env, commandLine: app.commandLine, defaultProfile: join(app.getPath('appData'), app.getName()), platform: process.platform })"])
  })

  // #284 refused every packaged debugging port, which also stopped scripts/packaged-smoke.mjs and portable-smoke.mjs.
  it('keeps the debugging port only for a packaged smoke run on a profile other than the user\'s', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\me\\AppData\\Roaming' : '/home/me/.config'
    const defaultProfile = join(home, 'Varia SQL Manager')
    const throwaway = join(home, '..', 'smoke-profile')
    const commandLine = (switches: Record<string, string>) => ({ hasSwitch: (name: string) => name in switches, getSwitchValue: (name: string) => switches[name] ?? '' })
    const smoke = { [packagedSmokeVariable]: '1' }
    const allowed = (options: { packaged?: boolean, env?: NodeJS.ProcessEnv, switches: Record<string, string> }) =>
      smokeDebuggingProfile({ packaged: options.packaged ?? true, env: options.env ?? smoke, commandLine: commandLine(options.switches), defaultProfile, platform: process.platform })
    const port = { 'remote-debugging-port': '9222', 'user-data-dir': throwaway }
    expect(allowed({ switches: port })).toBe(throwaway)
    expect(packagedSmokeVariable).toBe('VARIA_PACKAGED_SMOKE')
    // Not packaged (nothing is stripped there anyway), no variable, or any other value of it.
    expect(allowed({ packaged: false, switches: port })).toBeNull()
    expect(allowed({ env: {}, switches: port })).toBeNull()
    for (const value of ['true', 'yes', '0', ' 1', '']) expect(allowed({ env: { [packagedSmokeVariable]: value }, switches: port }), value).toBeNull()
    // Only the port, listening on loopback: no pipe, no other address.
    expect(allowed({ switches: { ...port, 'remote-debugging-pipe': '' } })).toBeNull()
    expect(allowed({ switches: { ...port, 'remote-debugging-address': '0.0.0.0' } })).toBeNull()
    expect(allowed({ switches: { 'remote-debugging-pipe': '', 'user-data-dir': throwaway } })).toBeNull()
    // An explicit, absolute profile that is not the user's own, however it is spelled.
    expect(allowed({ switches: { 'remote-debugging-port': '9222' } })).toBeNull()
    expect(allowed({ switches: { ...port, 'user-data-dir': '' } })).toBeNull()
    expect(allowed({ switches: { ...port, 'user-data-dir': 'relative/profile' } })).toBeNull()
    expect(allowed({ switches: { ...port, 'user-data-dir': defaultProfile } })).toBeNull()
    expect(allowed({ switches: { ...port, 'user-data-dir': `${defaultProfile}${process.platform === 'win32' ? '\\' : '/'}` } })).toBeNull()
    expect(allowed({ switches: { ...port, 'user-data-dir': join(defaultProfile, '..', 'Varia SQL Manager') } })).toBeNull()
    if (process.platform !== 'linux') expect(allowed({ switches: { ...port, 'user-data-dir': defaultProfile.toUpperCase() } })).toBeNull()
    // Kept switches stay on the command line, and the refusal sees none.
    const present = new Set(['remote-debugging-port', 'user-data-dir'])
    const line = { hasSwitch: (name: string) => present.has(name), removeSwitch: (name: string) => { present.delete(name) } }
    expect(stripRemoteDebugging(line, true, allowed({ switches: port }))).toBe(false)
    expect([...present]).toEqual(['remote-debugging-port', 'user-data-dir'])
    expect(stripRemoteDebugging(line, true, null)).toBe(true)
    expect([...present]).toEqual(['user-data-dir'])
  })

  it('runs a packaged smoke run on its own profile with saved passwords locked', async () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const switchProfile = main.indexOf("app.setPath('userData', smokeProfile)")
    expect(switchProfile).toBeGreaterThan(main.indexOf('const remoteDebugging = stripRemoteDebugging('))
    // Before anything reads the profile or takes the single-instance lock, which Chromium keeps in it.
    expect(switchProfile).toBeLessThan(main.indexOf("app.getPath('userData')"))
    expect(switchProfile).toBeLessThan(main.indexOf('app.requestSingleInstanceLock('))
    expect(main).toContain('const secretCipher = smokeProfile ? lockedCipher() :')
    const cipher = lockedCipher()
    expect(await cipher.state()).toEqual({ available: false, reason: 'unavailable' })
    await expect(cipher.encrypt('secret')).rejects.toThrow('The operating system could not protect the secret.')
    await expect(cipher.decrypt(Buffer.from('ciphertext'))).rejects.toThrow('The operating system could not read the protected secret.')
    // The smoke scripts that need the port ask for it, each on a profile of its own.
    for (const file of ['scripts/packaged-smoke.mjs', 'scripts/portable-smoke.mjs']) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).toContain("VARIA_PACKAGED_SMOKE: '1'")
      expect(source, file).toContain('`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`')
    }
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
